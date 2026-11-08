/**
 * Small, failure-tolerant wrappers around Web Storage. Private windows or blocked storage must never
 * break the game — values just won't persist.
 *
 * sessionStorage (per tab): the reconnect session token, so a refresh resumes you.
 * localStorage (per browser): sound settings (see audio/audio.ts) and the open payment id.
 */
function get(store: () => Storage, key: string): string | null {
  try { return store().getItem(key); } catch { return null; }
}
function set(store: () => Storage, key: string, value: string | null): void {
  try { if (value === null) store().removeItem(key); else store().setItem(key, value); } catch { /* not persisted */ }
}
const local = () => window.localStorage;
const session = () => window.sessionStorage;

export const sessionState = {
  token: () => get(session, 'rip.session'),
  setToken: (v: string | null) => set(session, 'rip.session', v),
};
