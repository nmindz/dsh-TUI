/**
 * Bounded cache for the text-measurement hot paths (display width, wrapping).
 *
 * Layout re-measures mounted text nodes in the same order every pass, so
 * accesses are cyclic: dropping the whole table on overflow collapses the hit
 * rate to zero. Evict oldest instead, and size budgets to hold a mounted
 * transcript. Hits stay Map-mutation-free — these paths run ~100k lookups per
 * frame, so recency bookkeeping would cost more than it buys.
 * @module
 */

/** Bounded cache keyed by measured text, evicting oldest entries first. */
export class BoundedTextCache<V> {
  readonly #maxEntries: number
  readonly #maxChars: number
  readonly #map = new Map<string, V>()
  #chars = 0

  /**
   * @param maxEntries - entry ceiling before oldest entries are evicted.
   * @param maxChars - ceiling on retained key characters before eviction.
   */
  constructor(maxEntries: number, maxChars: number) {
    this.#maxEntries = maxEntries
    this.#maxChars = maxChars
  }

  /**
   * Look up a memoized value.
   * @param key - the measured text, or a composite key embedding it.
   * @returns the cached value, or undefined on a miss.
   */
  get(key: string): V | undefined {
    return this.#map.get(key)
  }

  /**
   * Memoize a value, evicting oldest entries until both budgets hold.
   * @param key - the measured text, or a composite key embedding it; callers
   *   pass a string that does not retain a larger parent buffer.
   * @param value - the computed measurement to retain.
   */
  set(key: string, value: V): void {
    if (this.#map.has(key)) {
      this.#map.set(key, value)
      return
    }

    this.#map.set(key, value)
    this.#chars += key.length

    while (
      (this.#map.size > this.#maxEntries || this.#chars > this.#maxChars) &&
      this.#map.size > 1
    ) {
      const oldest = this.#map.keys().next()
      if (oldest.done === true) break
      this.#map.delete(oldest.value)
      this.#chars -= oldest.value.length
    }
  }

  /** Entry count. */
  get size(): number {
    return this.#map.size
  }

  /** Retained key characters. */
  get chars(): number {
    return this.#chars
  }

  /** Drop every entry. */
  clear(): void {
    this.#map.clear()
    this.#chars = 0
  }
}
