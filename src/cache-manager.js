/**
 * CacheManager: Lightweight TTL/LRU cache with path-based invalidation
 * Designed for low memory overhead and low token usage.
 */
export class CacheManager {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries || 200;
    this.defaultTtlMs = options.defaultTtlMs || 15000; // 15 seconds
    this.cache = new Map(); // key -> { value, expiresAt, path }
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value, filePath = null, ttlMs = this.defaultTtlMs) {
    if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      path: filePath
    });
  }

  invalidatePath(filePath) {
    if (!filePath) return;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.path && (entry.path === filePath || entry.path.startsWith(filePath))) {
        this.cache.delete(key);
      }
    }
  }

  clear() {
    this.cache.clear();
  }

  getMetrics() {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? (this.hits / total).toFixed(3) : 0;
    return {
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: Number(hitRate)
    };
  }
}
