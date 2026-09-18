// localStorage does not merely go missing -- it throws.
//
// Sandboxed iframes, `file://` origins, and managed/corporate browser policies
// that block site data all raise "Access is denied for this document" on the
// very first property access. Every read in this app was unguarded behind only
// a `typeof window === 'undefined'` SSR check, which does not help in a browser
// where `window` exists but storage is denied. The first such read happened in
// a `useState` initializer during App's first render, so the whole component
// tree failed to mount.
//
// Reads and writes fall back to an in-memory map: preferences and the session
// id stop surviving a page reload, but the app runs.

const memory = new Map<string, string>();

let available: boolean | null = null;

function usable(): boolean {
  // Never cache the server-side answer -- the same module instance is reused
  // on the client, where storage may well be available.
  if (typeof window === 'undefined') return false;
  if (available !== null) return available;

  try {
    const probe = '__storage_probe__';
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    available = true;
  } catch {
    available = false;
    console.warn(
      '[safeStorage] localStorage is blocked; preferences and session id will ' +
        'not persist across reloads.',
    );
  }
  return available;
}

export function getStoredItem(key: string): string | null {
  try {
    if (usable()) return window.localStorage.getItem(key);
  } catch {
    // Policy can change mid-session; fall through to the memory copy.
  }
  return memory.get(key) ?? null;
}

export function setStoredItem(key: string, value: string): void {
  try {
    if (usable()) {
      window.localStorage.setItem(key, value);
      return;
    }
  } catch {
    // Quota exceeded or access revoked; keep it in memory instead.
  }
  memory.set(key, value);
}

/** True when writes will survive a reload. Useful for warning the user. */
export function isStoragePersistent(): boolean {
  return usable();
}
