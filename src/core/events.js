// Tiny pub/sub. Canonical event names live in ARCHITECTURE.md §6.
// DOM-free.

const listeners = new Map(); // name -> Set<fn>

export function on(name, fn) {
  let set = listeners.get(name);
  if (!set) { set = new Set(); listeners.set(name, set); }
  set.add(fn);
  return () => off(name, fn);
}

export function off(name, fn) {
  const set = listeners.get(name);
  if (set) set.delete(fn);
}

export function emit(name, payload) {
  const set = listeners.get(name);
  if (!set) return;
  for (const fn of [...set]) fn(payload);
}

export function clearAll() { listeners.clear(); }
