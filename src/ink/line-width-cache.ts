import { BoundedTextCache } from './bounded-text-cache.js'
import { stringWidth } from './stringWidth.js'

// Budgets hold a whole long-session transcript, not a frame's worth: a
// smaller budget makes each layout pass evict what the next pass re-measures.
const MAX_CACHE_SIZE = 32_768
const MAX_CACHE_CHARS = 2_000_000
// Only pathological single lines are refused; the char budget governs the
// rest. Long lines are the costliest to measure, so excluding them backfires:
// one uncached 30KB line costs ~4ms per layout pass, several times the whole
// cached working set. Streaming-tail churn stays bounded by eviction, and
// most callers measure already-wrapped text near terminal width.
const MAX_CACHEABLE_LINE = 65_536

const cache = new BoundedTextCache<number>(MAX_CACHE_SIZE, MAX_CACHE_CHARS)
// Counted on the miss path only, where a full measurement already runs.
let misses = 0

/**
 * Copy a string into a fresh flat string with no parent references.
 * A line substring'd out of a large streaming buffer is a V8 SlicedString
 * that pins the entire parent (the full message text); using it directly
 * as a cache key retains the parent for the lifetime of the entry.
 */
function detachString(s: string): string {
  return Buffer.from(s, 'utf8').toString('utf8')
}

/**
 * Measure the display width of a line, cached per line across calls.
 * Completed lines are immutable during streaming, so caching avoids
 * re-measuring hundreds of unchanged lines on every token.
 * @param line - the line to measure.
 * @returns the display width in terminal cells.
 */
export function lineWidth(line: string): number {
  const cached = cache.get(line)
  if (cached !== undefined) return cached

  misses += 1
  const width = stringWidth(line)

  if (line.length > MAX_CACHEABLE_LINE) return width

  cache.set(detachString(line), width)
  return width
}

/** Test seam: drop memoized widths so a regression can measure cold cost. */
export function resetLineWidthCacheForTest(): void {
  cache.clear()
  misses = 0
}

/** Test seam: retained entries, retained key characters, cumulative misses. */
export function lineWidthCacheStatsForTest(): {
  size: number
  chars: number
  misses: number
} {
  return { size: cache.size, chars: cache.chars, misses }
}
