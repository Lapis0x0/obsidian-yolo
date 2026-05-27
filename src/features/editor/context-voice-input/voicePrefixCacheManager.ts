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
 * Strategy (from the archive's "自适应上下文缓存" section):
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
 *   - Re-anchor when one of these is true:
 *       a) no anchor yet for this file
 *       b) cursor moved backward, past the anchor (user jumped up)
 *       c) the bytes at prefixStart no longer match the cached anchor
 *          hash (user edited the cached region)
 *       d) `cursor - prefixStart > maxPrefixChars` (grown too long; accept
 *          one cache miss to keep the prompt size bounded)
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
   * Hash of the bytes at `prefixStart` (small fixed-width window). If
   * this changes, the user has edited the cached region and the anchor
   * is no longer valid.
   */
  anchorHash: string
  createdAt: number
}

/**
 * Bytes of the prefix region used to detect drift. We don't hash the
 * entire cached range every call — for an 8000-char cache that would add
 * a perceptible CPU cost to every polish. Hashing the first 256 chars
 * catches all realistic edit cases (insert / delete at or after the
 * anchor); edits deep inside the cached region without changing the head
 * are unlikely and would only cause a minor prompt drift, not a
 * correctness issue.
 */
const ANCHOR_WINDOW_CHARS = 256

export class VoicePrefixCacheManager {
  private readonly cache = new Map<string, CacheEntry>()

  /**
   * Pick the slice + offset to send as `<cursor_before>`. Falls back to
   * a fresh anchor when no usable cache is available; otherwise returns
   * the anchored slice unchanged.
   *
   * `minPrefixChars` is the initial prefix length used when re-anchoring
   * (i.e. how much before-cursor context the FIRST polish of a new anchor
   * sees). Later calls keep that anchor and let the slice grow at the tail.
   * `maxPrefixChars` is the internal safety cap; once the grown slice would
   * exceed it, we re-anchor to keep the prompt bounded.
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
    const entry = cacheKey ? this.cache.get(cacheKey) : undefined

    const reanchor = (): PrefixSlicePick => {
      const newStart = Math.max(0, cursor - input.minPrefixChars)
      const slice = input.fullDocBefore.slice(newStart)
      if (cacheKey) {
        this.cache.set(cacheKey, {
          filePath: cacheKey,
          prefixStart: newStart,
          anchorHash: hashWindow(input.fullDocBefore, newStart),
          createdAt: Date.now(),
        })
      }
      return { slice, prefixStart: newStart, cacheMissExpected: true }
    }

    if (!entry) return reanchor()
    // Cursor moved BEFORE the anchor — user jumped backward, anchor is
    // outside the relevant region now.
    if (entry.prefixStart > cursor) return reanchor()
    // Slice grew past the cap. Drop and re-anchor (one cache miss).
    if (cursor - entry.prefixStart > input.maxPrefixChars) return reanchor()
    // Validate the anchor window — if the user edited the cached region
    // (or switched the file behind our back) the hash changes.
    const currentHash = hashWindow(input.fullDocBefore, entry.prefixStart)
    if (currentHash !== entry.anchorHash) return reanchor()

    return {
      slice: input.fullDocBefore.slice(entry.prefixStart),
      prefixStart: entry.prefixStart,
      cacheMissExpected: false,
    }
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

const hashWindow = (text: string, start: number): string => {
  const window = text.slice(start, start + ANCHOR_WINDOW_CHARS)
  // djb2 — same scheme as DocumentSummaryManager.
  let h = 5381
  for (let i = 0; i < window.length; i += 1) {
    h = ((h << 5) + h + window.charCodeAt(i)) | 0
  }
  // Prefix with the window length so a different-length anchor (e.g. at
  // doc end) doesn't collide with a same-hash longer window.
  return `${window.length.toString(36)}:${(h >>> 0).toString(36)}`
}
