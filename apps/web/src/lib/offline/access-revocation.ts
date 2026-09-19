'use client';

/** A session change is a lock, never permission to silently authenticate an old view. */
export function observeLocalAccessRevocation(onRevoked: () => void) {
  const channel = new BroadcastChannel('cirne-session');
  channel.onmessage = onRevoked;
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea === window.localStorage
      && (event.key === 'cirne-rotas.last-user-id' || event.key === null)) onRevoked();
  };
  window.addEventListener('storage', storageChanged);
  return () => {
    channel.close();
    window.removeEventListener('storage', storageChanged);
  };
}
