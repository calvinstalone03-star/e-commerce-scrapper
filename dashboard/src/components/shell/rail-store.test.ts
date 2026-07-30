import { beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * The sidebar's remembered width, tested without a renderer.
 *
 * What can actually break here is the store, not the React binding: whether the
 * value survives a reload, whether a toggle reaches the components reading it,
 * and whether the key stays the one already sitting in people's browsers. A
 * `window` stub covers all three; `useSyncExternalStore` is React's problem.
 */

const stored = new Map<string, string>();
const storageListeners = new Set<() => void>();

globalThis.window = {
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  },
  addEventListener: (type: string, listener: () => void) => {
    if (type === 'storage') storageListeners.add(listener);
  },
  removeEventListener: (type: string, listener: () => void) => {
    if (type === 'storage') storageListeners.delete(listener);
  },
} as unknown as Window & typeof globalThis;

/** What Chrome does in this tab when another tab writes the same key. */
function anotherTabWrote(value: string): void {
  stored.set('mcl:sidebar-collapsed', value);
  for (const listener of storageListeners) listener();
}

const rail = await import('@/components/shell/rail-store');

beforeEach(() => {
  stored.clear();
  storageListeners.clear();
});

describe('the rail store', () => {
  test('starts expanded when nothing was ever chosen', () => {
    expect(rail.readRail()).toBe(false);
  });

  test('remembers a collapsed rail, which is the whole point of storing it', () => {
    rail.writeRail(true);
    expect(rail.readRail()).toBe(true);

    rail.writeRail(false);
    expect(rail.readRail()).toBe(false);
  });

  test('keeps the key and values already in use, so nobody loses their choice', () => {
    // Changing either would silently expand every rail that is currently
    // collapsed, on every machine that has already used this dashboard.
    rail.writeRail(true);
    expect(stored.get('mcl:sidebar-collapsed')).toBe('1');
    rail.writeRail(false);
    expect(stored.get('mcl:sidebar-collapsed')).toBe('0');
  });

  test('tells its subscribers about a write', () => {
    const onChange = vi.fn();
    rail.subscribeRail(onChange);

    rail.writeRail(true);

    // Without this the toggle would store the new value and render the old one:
    // the `storage` event does not fire in the tab that did the writing.
    expect(onChange).toHaveBeenCalledOnce();
  });

  test('says nothing to a subscriber that has gone away', () => {
    const onChange = vi.fn();
    const unsubscribe = rail.subscribeRail(onChange);

    unsubscribe();
    rail.writeRail(true);

    expect(onChange).not.toHaveBeenCalled();
  });

  test('follows the same setting changed in another tab', () => {
    const onChange = vi.fn();
    rail.subscribeRail(onChange);

    anotherTabWrote('1');

    expect(onChange).toHaveBeenCalledOnce();
    expect(rail.readRail()).toBe(true);
  });

  test('reports expanded on the server, where there is no localStorage', () => {
    // Any other answer is markup that disagrees with the first client render.
    expect(rail.readRailOnServer()).toBe(false);
  });
});
