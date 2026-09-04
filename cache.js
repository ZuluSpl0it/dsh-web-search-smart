/** In-memory TTL + LRU cache. Per-process only; resets on restart (by design). */
export class TTLCache {
  #map = new Map();
  #ttlMs;
  #max;

  constructor({ ttlMs, max }) {
    this.#ttlMs = ttlMs;
    this.#max = max;
  }

  get(key) {
    const entry = this.#map.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.exp) {
      this.#map.delete(key);
      return undefined;
    }
    // refresh LRU recency
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.#map.size >= this.#max) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    this.#map.set(key, { value, exp: Date.now() + this.#ttlMs });
  }

  clear() {
    this.#map.clear();
  }
}
