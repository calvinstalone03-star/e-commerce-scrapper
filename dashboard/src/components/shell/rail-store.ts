/**
 * Whether the sidebar rail is collapsed — a setting that lives in localStorage
 * rather than in React.
 *
 * Read through `useSyncExternalStore` rather than "read it in an effect, then
 * setState": that version renders once with a guess and immediately again with
 * the truth, which is the cascading render React now warns about, and it cannot
 * see the same setting changed in another tab at all. Subscribing to the store
 * the value actually lives in does both correctly.
 *
 * A toggle that resets on every page load is a toggle nobody uses twice, which
 * is why this is persisted at all — the rail is collapsed to give a product
 * table its 15rem back, and that decision outlives one navigation.
 */

const STORAGE_KEY = 'mcl:sidebar-collapsed';

const listeners = new Set<() => void>();

export function subscribeRail(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  // Another tab writing this key is this setting changing, so it belongs on the
  // same subscription rather than being ignored until the next reload.
  window.addEventListener('storage', onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

export function readRail(): boolean {
  return window.localStorage.getItem(STORAGE_KEY) === '1';
}

/**
 * The server has no localStorage, so the markup it sends is the expanded rail.
 * Any other answer here is markup that disagrees with the first client render.
 */
export function readRailOnServer(): boolean {
  return false;
}

export function writeRail(collapsed: boolean): void {
  window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  // `storage` fires in every tab except the one that wrote, so this tab has to
  // be told by hand — otherwise the toggle stores the new value and goes on
  // rendering the old one.
  for (const listener of listeners) listener();
}
