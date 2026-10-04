// Small polyfills for newer JS features pdf.js uses, so Firefox ESR 140 works too.
for (const C of [Map, WeakMap]) {
  if (!C.prototype.getOrInsertComputed) {
    Object.defineProperty(C.prototype, 'getOrInsertComputed', {
      configurable: true, writable: true,
      value(key, fn) { if (this.has(key)) return this.get(key); const v = fn(key); this.set(key, v); return v; },
    });
  }
  if (!C.prototype.getOrInsert) {
    Object.defineProperty(C.prototype, 'getOrInsert', {
      configurable: true, writable: true,
      value(key, v) { if (this.has(key)) return this.get(key); this.set(key, v); return v; },
    });
  }
}
if (!Promise.try) {
  Promise.try = function (fn, ...args) { return new Promise((res) => res(fn(...args))); };
}
if (!Math.sumPrecise) {
  Math.sumPrecise = function (items) { let s = 0; for (const x of items) s += x; return s; };
}
