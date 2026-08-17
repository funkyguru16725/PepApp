// Intentionally minimal: this service worker's only job is receiving push
// notifications and handling taps on them. It does NOT intercept fetch()
// requests or cache anything — that caused real problems before, so this
// version deliberately stays out of the way of normal page loading.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || "Peptide Tracker";
  const options = {
    body: data.body || "Time to log today's doses.",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
  };
  event.waitUntil(self.registration.showNotification(title, options));
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
