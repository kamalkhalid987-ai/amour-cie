self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};

  const title = data.title || 'Amour Compagnie';
  const options = {
    body: data.body || 'Vous avez une nouvelle notification.',
    icon: '/welcome-banner.jpg',
    badge: '/welcome-banner.jpg',
    data: {
      url: data.url || '/'
    }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil(
    clients.openWindow(event.notification.data.url || '/')
  );
});