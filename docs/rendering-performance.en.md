# Render cache budgets and how they were sized

This note records **why the cache budgets on the render hot path hold their current values**, and what breaks when they are set too low. For the overview, see the "Rendering and long-session performance" section of [Architecture and limitations](architecture.en.md).

Upstream trimmed `docs/project-documentation/` in #804; this note keeps the measurement evidence from it that still applies.

## Caches and measurement

| Component | Location | Behavior |
| --- | --- | --- |
| line-width-cache | `src/ink/line-width-cache.ts` | Caches stringWidth per line (completed lines are immutable while streaming, cutting roughly 50x the calls per token). Bounded through `BoundedTextCache`: 32768 entries / 2M character budget / lines over 65536 characters are never cached / oldest-first eviction on overflow (**not** a full flush). detachString copies keys through a Buffer round-trip so a V8 SlicedString cannot pin the whole streaming parent string (measured: 10KB lines x 3000 frames, 1.15GB -> 2.3MB resident). |
| Cross-mount wrap cache | `src/ink/wrap-text.ts` | Content-addressed cache of (text, maxWidth, wrapType) -> wrap result, serving two recompute paths: virtualization unmounts scrolled-out lines and re-wraps the whole block when they remount, and paint has no per-node cache for visible text nodes. Bounded through `BoundedTextCache`: 16384 entries / 2M characters / oldest-first eviction. Entry count, not character count, is the binding constraint here — a long session mounts thousands of text nodes at once. |
| Yoga per-node layout cache | `src/native-ts/yoga-layout/index.ts` | One slot `_hasL` (the inputs of the most recent layout pass) plus `CACHE_SLOT_CAPACITY=16` slots `_cIn/_cOut` (input group -> w/h) with round-robin eviction. The multi-slot cache serves the measure pass only. |

## Sizing the line-width budget (`MAX_CACHE_CHARS` / `MAX_CACHEABLE_LINE`)

Every layout pass re-measures all mounted text nodes in the same order, which is cyclic access. Under cyclic access, "flush the whole table on overflow" forces the next pass to re-measure exactly what it just discarded: the hit rate does not degrade gradually, it collapses to ~0 and **never converges**.

Measured (a real session of 2586 events / 2.66MB, yielding 8394 transcript text lines / 657KB, against the old 100K character budget):

| Pass | Old behavior (4096 entries / 100K chars / full flush) | Current behavior (32768 entries / 2M chars / oldest-first) |
| --- | --- | --- |
| 0 (cold) | 97.37ms, 88% miss, 4 flushes | 63.88ms |
| 1 | 29.49ms, 89% miss, 5 flushes | 0.96ms |
| 2 | 36.36ms, 89% miss, 5 flushes | 0.89ms |
| 3 | 29.98ms, 88% miss, 5 flushes | 0.89ms |

Steady state is roughly 33x (29.98 -> 0.89ms per pass). Note that LRU collapses just as badly as FIFO under cyclic access, so the fix is **budget >= working set**; the eviction policy only absorbs outliers. That is why the hit path keeps no recency bookkeeping — it serves around 100K lookups per frame.

Why `MAX_CACHEABLE_LINE` is large: line lengths in that session were p50 52 / p90 132 / p99 515 / p99.9 2273 / max 30306. A 4096 ceiling already covers nearly every line and looks sufficient, but excluding the single 30KB line that exceeds it costs **4.089ms** of re-measurement per layout pass — about 4.5x the entire cached working set (0.89ms). Long lines are precisely the expensive ones, so excluding them is a net loss. The ceiling therefore only blocks pathological lines (65536).

Regression: `scripts/verify-text-measure-cache.ts` (`render-scroll` group). Negative control: restoring the old budget adds 6060 misses on the second pass (6060 unique keys among 8394 lines), a 100% miss rate, and both retained assertions fail together.

## Sizing the slot budget (`CACHE_SLOT_CAPACITY`)

The budget has to cover "how many input groups probe the same node within one frame". Otherwise round-robin eviction meets a cyclic probe order and the hit rate collapses to ~0 — the same class of defect as the overflow collapse in line-width-cache and wrap-text, only with a different eviction policy.

Measured (the steady workload in `scripts/bench-yoga.tsx`: 108x34, a 187-node tree with 81 measure nodes, pure streaming append with no resize):

| Input groups per node | 4 | 6 | 8 | 11 |
| --- | --- | --- | --- | --- |
| Node count | 2 | 1 | 19 | 3 |

So 22 of the 25 hot nodes have a working set of 8–11 groups, while the old budget was 4. Consequences and the effect of the fix (same machine, same workload):

| Budget | measure calls per frame | layoutNode visits per frame |
| --- | --- | --- |
| 4 (old) | ~1425 | ~4506 |
| 16 | ~12 | ~554 |

Once a hit lands, the cascade short-circuits at the container level and the leaves below are never walked — that is why 1425 -> 12 goes so far past the "209 distinct input groups" lower bound.

## Multi-slot hits serve the measure pass only

An early return in the layout pass skips the child-positioning recursion (STEP 5). At any instant a subtree sits in exactly one laid-out state: the one matching the inputs of its last layout pass, which is what `_hasL` holds. Letting the multi-slot cache serve the layout pass would let a container hit the w/h of *another* input group and skip the recursion, leaving the skipped subtree on the temporary geometry written by a measure probe (observed: the timeline vertical axis `ink-text` stuck at 1 row high while its outer frame was already 5 rows). Raising the slot count from 4 to 16 makes such hits far more likely, so multi-slot reads are restricted to `!performLayout`.

Regression: `scripts/verify-yoga-layout-cache.ts` (render-scroll group). Staleness is judged by byte equality between the cached result and a full-tree recompute after markTreeDirty. Four negative controls: removing markDirty must read a stale value, returning the budget to 4 must fail both the unit and full-tree assertions, and re-enabling layout-pass hits must fail the staleness assertion.
