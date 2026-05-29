/**
 * Per-file anchored prefix cache for the voice-input polish prompt.
 *
 * Why this exists:
 *   The naive way to assemble `<cursor_before>` is "the last N characters
 *   of the text before the cursor". That makes the slice's START byte move
 *   forward whenever the user inserts content — and most provider prefix
 *   caches (OpenAI / DeepSeek automatic, Anthropic `cache_control`) only
 *   hit when the leading bytes of the prompt are IDENTICAL across calls.
 *   So the naive sliding window misses cache on every polish.
 *
 * Strategy:
 *   - Anchor `prefixStart` to a FIXED document offset chosen at the start
 *     of a dictation arc (or the last re-anchor).
 *   - On subsequent polishes within the same file, return
 *     `doc.slice(prefixStart, cursor)` — the slice grows only at the TAIL
 *     as the user writes / accepts text, leaving the leading bytes (and
 *     the upstream prompt cache) untouched.
 *   - The user-facing before-cursor window is the INITIAL anchored length.
 *     The returned slice can then grow naturally as dictation inserts text
 *     after the anchor. `maxPrefixChars` is only the internal safety cap that
 *     forces a re-anchor when the prefix has grown too large.
 *   - Keep MULTIPLE anchors per file (LRU, default 4 slots). When the user
 *     jumps to a remote region and later returns, the original region's
 *     anchor is still cached — the upstream prompt cache hits again instead
 *     of cold-starting. A single anchor would get evicted by the first
 *     "long jump", losing all benefit on the return trip.
 *   - On `pickBeforeSlice`, pick the legal anchor with the SMALLEST
 *     `prefixStart` (longest slice = longest cacheable prefix); if no
 *     anchor is legal, create a new one and LRU-evict the oldest.
 *   - An anchor is "legal" iff:
 *       a) cursor >= anchor.prefixStart   (didn't jump up past it)
 *       b) cursor - anchor.prefixStart <= maxPrefixChars   (slice within cap)
 *       c) bytes at prefixStart still match the cached anchor bytes
 *          (no edits at or before the anchor offset)
 *
 * The after-cursor window is NOT cached. It's short (default 600 chars)
 * and shifts with every cursor move; the bookkeeping cost outweighs the
 * cache benefit.
 *
 * Storage is in-memory, keyed by file path. Never persisted. Use
 * `forget(path)` on file/folder rename / delete and `clear()` on plugin
 * teardown.
 */

export type PrefixSlicePick = {
  /** The slice that should be sent as `<cursor_before>`. */
  slice: string
  /** The doc offset where the slice begins. Useful for telemetry. */
  prefixStart: number
  /**
   * True when this call re-anchored. The next polish should be a cache
   * hit; this one likely misses. Surfaced for debug / metrics only.
   */
  cacheMissExpected: boolean
}

type CacheEntry = {
  filePath: string
  prefixStart: number
  /**
   * The actual characters at `[prefixStart, prefixStart + ANCHOR_WINDOW_CHARS)`
   * when the anchor was set, truncated if the cursor was closer than that.
   * On the next call we re-read the same captured length from the current
   * document and compare bytes directly; if they differ, the user has edited
   * at or before the anchor offset and the anchor is no longer pointing at
   * the same content as before — re-anchor.
   */
  anchorBytes: string
  /**
   * Monotonic counter assigned on creation and bumped on every reuse;
   * higher = more recently used. Used for LRU eviction. A counter rather
   * than `Date.now()` so back-to-back calls within the same millisecond
   * (synthetic tests, very rapid dictation) still produce a strict order.
   */
  useOrder: number
}

/**
 * Width of the "anchor window" — the bytes at the anchor we sample to
 * detect that the document has shifted at or before our anchor offset.
 *
 * Two reasons this is small and not the full cached region:
 *
 * 1. **Deliberate tolerance for mid-slice edits.** When the user edits the
 *    middle of the cached region (past the anchor window), we don't notice,
 *    and we keep using the existing anchor. The upstream prompt cache then
 *    partially hits (the common prefix up to the edit point). If we DID
 *    detect mid-slice edits and re-anchored, the new slice would be
 *    completely fresh content — upstream cache drops back to system+meta
 *    only. So this is a feature, not a perf hack.
 *
 * 2. The CPU cost of comparing the full 8000-char cached region every
 *    polish is negligible in modern browsers (~16 µs per call per a 50KB-doc
 *    microbenchmark). 256 chosen here was not for performance.
 *
 * Any insert/delete *at or before* the anchor offset shifts the bytes at
 * `prefixStart` — even a 1-char delta would change the window content.
 * 256 is comfortably above the minimum needed for unambiguous detection.
 */
const ANCHOR_WINDOW_CHARS = 256

/**
 * Default number of anchors retained per file. 4 was picked empirically:
 * cache hit rate is essentially flat from N=4 onwards in the bench's
 * "user revises in multiple regions of the same doc" scenarios; lower
 * values lose cache on each region transition. See
 * `Design/Tests/voice-prefix-cache/pairwise.md`.
 */
const DEFAULT_SLOTS_PER_FILE = 4

export type VoicePrefixCacheOptions = {
  /** Per-file LRU capacity. Defaults to {@link DEFAULT_SLOTS_PER_FILE}. */
  slotsPerFile?: number
}

export class VoicePrefixCacheManager {
  private readonly slotsPerFile: number
  private readonly cache = new Map<string, CacheEntry[]>()
  private useCounter = 0

  constructor(options: VoicePrefixCacheOptions = {}) {
    this.slotsPerFile = Math.max(
      1,
      options.slotsPerFile ?? DEFAULT_SLOTS_PER_FILE,
    )
  }

  private nextUseOrder(): number {
    this.useCounter += 1
    return this.useCounter
  }

  /**
   * Pick the slice + offset to send as `<cursor_before>`. Returns the
   * widest legal anchor (smallest `prefixStart`) for the file; if none
   * are legal, creates a new anchor and LRU-evicts the oldest when full.
   *
   * `minPrefixChars` is the initial prefix length used when creating a new
   * anchor (i.e. how much before-cursor context the FIRST polish of a new
   * anchor sees). Later calls keep that anchor and let the slice grow at
   * the tail. `maxPrefixChars` is the internal safety cap; once the grown
   * slice would exceed it, the anchor is no longer legal and a new one is
   * created.
   */
  pickBeforeSlice(input: {
    filePath: string
    /** All text from doc start to the cursor. */
    fullDocBefore: string
    minPrefixChars: number
    maxPrefixChars: number
  }): PrefixSlicePick {
    const cursor = input.fullDocBefore.length
    const cacheKey = input.filePath || ''
    const slots = cacheKey ? (this.cache.get(cacheKey) ?? []) : []

    // Find every still-legal anchor.
    const legal: CacheEntry[] = []
    for (const entry of slots) {
      if (entry.prefixStart > cursor) continue
      if (cursor - entry.prefixStart > input.maxPrefixChars) continue
      if (
        anchorBytesAt(input.fullDocBefore, entry.prefixStart, entry) !==
        entry.anchorBytes
      ) {
        continue
      }
      legal.push(entry)
    }

    if (legal.length > 0) {
      // Smallest prefixStart = longest slice = longest cacheable prefix.
      legal.sort((a, b) => a.prefixStart - b.prefixStart)
      const best = legal[0]
      best.useOrder = this.nextUseOrder()
      return {
        slice: input.fullDocBefore.slice(best.prefixStart),
        prefixStart: best.prefixStart,
        cacheMissExpected: false,
      }
    }

    // No legal anchor — create one.
    const newStart = Math.max(0, cursor - input.minPrefixChars)
    const slice = input.fullDocBefore.slice(newStart)
    if (cacheKey) {
      const newEntry: CacheEntry = {
        filePath: cacheKey,
        prefixStart: newStart,
        anchorBytes: anchorBytesAt(input.fullDocBefore, newStart),
        useOrder: this.nextUseOrder(),
      }
      // Dedup at same offset (can happen if a previous anchor at this
      // offset was invalidated by an edit, then the document was edited
      // back).
      const nextSlots = slots.filter((e) => e.prefixStart !== newStart)
      nextSlots.push(newEntry)
      // LRU evict by useOrder — drop the oldest until we fit.
      if (nextSlots.length > this.slotsPerFile) {
        nextSlots.sort((a, b) => a.useOrder - b.useOrder)
        nextSlots.splice(0, nextSlots.length - this.slotsPerFile)
      }
      this.cache.set(cacheKey, nextSlots)
    }
    return { slice, prefixStart: newStart, cacheMissExpected: true }
  }

  /** Forget the cache for a file path, or every cached file under a folder. */
  forget(filePath: string): void {
    if (!filePath) return
    const childPrefix = `${filePath}/`
    for (const key of this.cache.keys()) {
      if (key === filePath || key.startsWith(childPrefix)) {
        this.cache.delete(key)
      }
    }
  }

  /** Wipe everything (plugin teardown). */
  clear(): void {
    this.cache.clear()
  }
}

// Direct byte storage instead of hashing. Reasons:
//
//  - There is no measurable performance win to hashing here. We compare one
//    cached value against one current value per file per polish call; not a
//    hash-table lookup. String compare on 256 chars is microseconds either
//    way.
//  - Saving the original bytes is what we actually mean: "is the doc still
//    the same at this offset?". The hash was an obfuscation of that.
//  - When the anchor sits near the cursor, the first window may be shorter
//    than 256 chars. Later typing extends the document tail, so compare only
//    the originally captured length; otherwise a stable anchor would miss
//    just because more text now exists after it.
//
// Memory cost: 256 chars × slotsPerFile (4) × N files ≈ 100KB at 100 cached
// files. Negligible.
const anchorBytesAt = (
  text: string,
  start: number,
  existing?: Pick<CacheEntry, 'anchorBytes'>,
): string => {
  const length = existing?.anchorBytes.length ?? ANCHOR_WINDOW_CHARS
  return text.slice(start, start + length)
}
