/**
 * Small, failure-tolerant wrappers around Web Storage. Private windows or blocked storage must never
 * break the game — values just won't persist.
 *
 * sessionStorage (per tab): the reconnect session token, so a refresh resumes you.
 * localStorage (per browser): display name and graphics preferences.
 */
function get(store: () => Storage, key: string): string | null {
  try { return store().getItem(key); } catch { return null; }
}
function set(store: () => Storage, key: string, value: string | null): void {
  try { if (value === null) store().removeItem(key); else store().setItem(key, value); } catch { /* not persisted */ }
}
const local = () => window.localStorage;
const session = () => window.sessionStorage;

export const prefs = {
  name: () => get(local, 'rip.name'),
  setName: (v: string) => set(local, 'rip.name', v),
  shadows: () => get(local, 'rip.shadows') !== '0',
  setShadows: (on: boolean) => set(local, 'rip.shadows', on ? '1' : '0'),
  resolution: (): 'high' | 'balanced' | 'low' => {
    const v = get(local, 'rip.resolution');
    return v === 'balanced' || v === 'low' ? v : 'high';
  },
  setResolution: (v: string) => set(local, 'rip.resolution', v),
  seenControls: () => get(local, 'rip.seenControls') === '1',
  setSeenControls: () => set(local, 'rip.seenControls', '1'),
};

export const sessionState = {
  token: () => get(session, 'rip.session'),
  setToken: (v: string | null) => set(session, 'rip.session', v),
};
