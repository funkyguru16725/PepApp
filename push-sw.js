// This service worker receives push notifications, shows them, and also
// logs each one into IndexedDB so the app's Notifications tab can show
// real-time and historical notifications even if the app was closed when
// they arrived (localStorage isn't accessible from a service worker, so
// IndexedDB is the only client-side storage that works for this).

const DB_NAME = "peptide-notifications-db";
const STORE_NAME = "notifications";
const MAX_STORED = 200;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("timestamp", "timestamp");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function logNotification(title, body) {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  store.add({ title, body, timestamp: Date.now() });

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

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "Peptide Tracker";
  const body = data.body || "Time to log today's doses.";
  const options = {
    body,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
  };
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(title, options),
      logNotification(title, body),
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
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./");
    })
  );
});
