// Android System WebView can lag behind desktop Chromium. Keep the small set of
// language features used by the mobile dependency graph available before App
// (and Mermaid) are evaluated.
if (!Object.hasOwn) {
  Object.hasOwn = (object: object, property: PropertyKey) =>
    Object.prototype.hasOwnProperty.call(object, property);
}

if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, "at", {
    configurable: true,
    writable: true,
    value<T>(this: T[], index: number): T | undefined {
      const normalized = Math.trunc(index) || 0;
      const offset = normalized < 0 ? this.length + normalized : normalized;
      return this[offset];
    },
  });
}
