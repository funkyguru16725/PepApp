// This service worker receives push notifications, shows them, logs them
// into IndexedDB (so the app's Notifications tab has history even for
// pushes that arrived while the app was closed), and handles action button
// taps on dose-reminder notifications.
//
// IMPORTANT CONSTRAINT: a service worker cannot access the main app's
// localStorage. Everything it needs — the Worker URL/API key for making an
// authenticated call, and any action the person takes on a notification —
// has to go through IndexedDB, which is the one storage mechanism both the
// SW and the main app can read and write.

const DB_NAME = "peptide-notifications-db";
const NOTIF_STORE = "notifications";
const CONFIG_STORE = "config";
const PENDING_STORE = "pendingActions";
const MAX_STORED = 200;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    let settled = false;
    // If another open connection (e.g. the main app tab) is holding an older
    // version of this database, the upgrade blocks until that connection
    // closes — which might never happen promptly. Without this, a blocked
    // upgrade hangs the push event's logging step forever, even though the
    // notification itself still displays fine (that doesn't depend on IndexedDB).
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error("IndexedDB upgrade blocked by another open connection"));
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("IndexedDB open timed out"));
    }, 3000);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTIF_STORE)) {
        const store = db.createObjectStore(NOTIF_STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex("timestamp", "timestamp");
      }
      if (!db.objectStoreNames.contains(CONFIG_STORE)) {
        db.createObjectStore(CONFIG_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(req.error);
    };
  });
}

async function logNotification(title, body, extraData) {
  const db = await openDb();
  const tx = db.transaction(NOTIF_STORE, "readwrite");
  const store = tx.objectStore(NOTIF_STORE);
  store.add({ title, body, timestamp: Date.now(), data: extraData || null });

  // Prune down to the most recent MAX_STORED entries so this can't grow
  // without bound over months of daily reminders.
  const countReq = store.count();
  countReq.onsuccess = () => {
    const excess = countReq.result - MAX_STORED;
    if (excess > 0) {
      const cursorReq = store.index("timestamp").openCursor();
      let deleted = 0;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (cursor && deleted < excess) {
          cursor.delete();
          deleted++;
          cursor.continue();
        }
      };
    }
  };
  return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
}

async function getConfig(key) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(CONFIG_STORE, "readonly");
    const req = tx.objectStore(CONFIG_STORE).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => resolve(null);
  });
}

async function addPendingAction(action) {
  const db = await openDb();
  const tx = db.transaction(PENDING_STORE, "readwrite");
  tx.objectStore(PENDING_STORE).add({ ...action, createdAt: Date.now() });
  return new Promise((resolve) => { tx.oncomplete = () => resolve(); });
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "Peptide Tracker";
  const body = data.body || "Time to log today's doses.";
  const extra = data.data || null; // { type, date, compoundIds } for dose reminders

  const options = {
    body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    data: extra,
  };
  // Action buttons only make sense on dose reminders — a "Mark taken" button
  // on a weekly summary or plateau alert wouldn't mean anything.
  if (extra && extra.type === "dose-reminder") {
    options.actions = [
      { action: "mark-taken", title: "Mark taken" },
      { action: "snooze", title: "Snooze 15 min" },
    ];
  }

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      logNotification(title, body, extra).catch((e) => console.error("Failed to log notification:", e)),
      // Tell any open tabs to refresh their notifications list immediately,
      // so the in-app history feels real-time rather than only updating on
      // next reload.
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
        clientList.forEach((client) => client.postMessage({ type: "new-notification", title, body, timestamp: Date.now() }));
      }),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  const action = event.action; // "" if the notification body itself was tapped
  const extra = event.notification.data;
  event.notification.close();

  if (action === "mark-taken" && extra?.compoundIds) {
    event.waitUntil(
      addPendingAction({ type: "mark-taken", compoundIds: extra.compoundIds, date: extra.date }).then(() =>
        // Nudge any open tab to apply this immediately rather than waiting
        // for next launch.
        self.clients.matchAll({ type: "window", includeUncontrolled: true })
      ).then((clientList) => {
        clientList.forEach((client) => client.postMessage({ type: "pending-action-added" }));
      })
    );
    return;
  }

  if (action === "snooze" && extra?.compoundIds) {
    event.waitUntil(
      (async () => {
        const workerUrl = await getConfig("workerUrl");
        const apiKey = await getConfig("apiKey");
        if (!workerUrl) return;
        try {
          await fetch(`${workerUrl}/snooze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-API-Key": apiKey || "" },
            body: JSON.stringify({ compoundIds: extra.compoundIds, minutes: 15 }),
          });
        } catch (e) {
          // best-effort — if this fails, the original reminder already fired
          // and the person can still mark it taken manually in the app
        }
      })()
    );
    return;
  }

  // Default: notification body tapped (not an action button) — just open the app.
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./");
    })
  );
});
