import { VoicePrefixCacheManager } from './voicePrefixCacheManager'

const MIN = 2000
const MAX = 8000

// Deterministic generator so tests don't drift if jest semantics change.
const genText = (seed: number, len: number): string => {
  let s = seed | 0
  const chars: string[] = []
  for (let i = 0; i < len; i += 1) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0
    // a-z to keep things ASCII / 1-char-per-token boundary irrelevant to behavior
    chars.push(String.fromCharCode(97 + ((s >>> 0) % 26 | 0)))
  }
  return chars.join('')
}

describe('VoicePrefixCacheManager', () => {
  it('cold-start: first call always re-anchors', () => {
    const mgr = new VoicePrefixCacheManager()
    const doc = genText(1, 5000)
    const pick = mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 3000),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    expect(pick.cacheMissExpected).toBe(true)
    expect(pick.prefixStart).toBe(3000 - MIN) // cursor=3000, anchor=cursor-min=1000
    expect(pick.slice).toBe(doc.slice(1000, 3000))
  })

  it('warm hit: consecutive polish at growing cursor reuses the same anchor', () => {
    const mgr = new VoicePrefixCacheManager()
    const doc = genText(2, 10000)
    const first = mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 3000),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    const second = mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 3500), // user wrote 500 more chars
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    expect(second.cacheMissExpected).toBe(false)
    expect(second.prefixStart).toBe(first.prefixStart)
    expect(second.slice.length).toBe(first.slice.length + 500)
  })

  it('backward jump past anchor → new anchor (legal anchor exists but is too far ahead)', () => {
    const mgr = new VoicePrefixCacheManager()
    const doc = genText(3, 10000)
    // First polish at cursor 5000 → anchor at 3000
    mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 5000),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    // Jump back to cursor 1500 — past anchor 3000
    const back = mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 1500),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    expect(back.cacheMissExpected).toBe(true)
    expect(back.prefixStart).toBe(0) // max(0, 1500-2000)=0
  })

  it('safety cap: cursor - prefixStart > maxPrefixChars triggers re-anchor', () => {
    const mgr = new VoicePrefixCacheManager()
    const doc = genText(4, 20000)
    // First polish at cursor 1000 → anchor at 0
    mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 1000),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    // Now cursor at 9500 — 9500 - 0 = 9500 > MAX(8000)
    const after = mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 9500),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    expect(after.cacheMissExpected).toBe(true)
    expect(after.prefixStart).toBe(9500 - MIN)
  })

  it('edit at/before anchor → anchor bytes drift → re-anchor', () => {
    const mgr = new VoicePrefixCacheManager()
    const doc = genText(5, 10000)
    mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 5000),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    // Insert ONE char at offset 100 (before anchor offset 3000). All offsets
    // after shift by 1, so the bytes the manager remembers at offset 3000
    // are now what used to be at 2999 — drift detected.
    const editedDoc = doc.slice(0, 100) + 'X' + doc.slice(100)
    const after = mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: editedDoc.slice(0, 5001),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    expect(after.cacheMissExpected).toBe(true)
  })

  it('edit deep inside slice (past anchor window) does NOT trigger re-anchor', () => {
    // The deliberate tolerance: mid-slice edits are accepted so the upstream
    // prefix cache still partially hits up to the edit point.
    const mgr = new VoicePrefixCacheManager()
    const doc = genText(6, 10000)
    mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: doc.slice(0, 5000),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    // First-polish anchor lands at offset 3000. The anchor window is
    // [3000, 3256). Insert at offset 4000 — well past the window, but
    // inside the cached slice [3000, cursor].
    const editedDoc = doc.slice(0, 4000) + 'X' + doc.slice(4000)
    const after = mgr.pickBeforeSlice({
      filePath: '/a.md',
      fullDocBefore: editedDoc.slice(0, 5001),
      minPrefixChars: MIN,
      maxPrefixChars: MAX,
    })
    expect(after.cacheMissExpected).toBe(false)
    expect(after.prefixStart).toBe(3000)
  })

  describe('multi-anchor: cross-region jumps', () => {
    it('jump to far region then back: original anchor is reused on return', () => {
      const mgr = new VoicePrefixCacheManager()
      const doc = genText(7, 30000)
      // Region A: anchor lands at 3000
      const a1 = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 5000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(a1.cacheMissExpected).toBe(true)
      // Jump to region B (far away) — new anchor at 18000
      const b1 = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 20000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(b1.cacheMissExpected).toBe(true)
      expect(b1.prefixStart).not.toBe(a1.prefixStart)
      // Jump back to region A — anchor at 3000 is STILL legal (cursor=5100 >=
      // 3000, cursor-anchor=2100 <= MAX, bytes unchanged). This is the
      // multi-anchor win — single-anchor would have evicted it.
      const a2 = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 5100),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(a2.cacheMissExpected).toBe(false)
      expect(a2.prefixStart).toBe(a1.prefixStart)
    })

    it('honours slotsPerFile=1 (single-anchor equivalence): far jump evicts original', () => {
      const mgr = new VoicePrefixCacheManager({ slotsPerFile: 1 })
      const doc = genText(8, 30000)
      const a1 = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 5000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 20000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      // Now return to region A. With 1 slot, the original anchor was
      // overwritten by the region-B anchor, so this must re-anchor.
      const a2 = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 5100),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(a2.cacheMissExpected).toBe(true)
      // sanity: the new anchor isn't the same as the first either
      void a1
    })

    it('LRU eviction: oldest anchor is dropped when 5th distinct region is anchored (slotsPerFile=4)', () => {
      const mgr = new VoicePrefixCacheManager({ slotsPerFile: 4 })
      const doc = genText(9, 50000)
      // 4 distinct regions, each spaced > MAX apart so a fresh anchor is
      // created every time (existing anchors are out of reach via the cap).
      // With MIN=2000 the anchors land at cursor-2000, so:
      //   cursor=3000  → anchor=1000  (covers cursors 1000..9000)
      //   cursor=12000 → anchor=10000 (covers cursors 10000..18000)
      //   cursor=21000 → anchor=19000 (covers cursors 19000..27000)
      //   cursor=30000 → anchor=28000 (covers cursors 28000..36000)
      const anchorOffsets = [3000, 12000, 21000, 30000].map((cursor) => {
        const r = mgr.pickBeforeSlice({
          filePath: '/a.md',
          fullDocBefore: doc.slice(0, cursor),
          minPrefixChars: MIN,
          maxPrefixChars: MAX,
        })
        expect(r.cacheMissExpected).toBe(true)
        return r.prefixStart
      })
      expect(anchorOffsets).toEqual([1000, 10000, 19000, 28000])
      // Touch the FIRST anchor again so it's not the LRU victim. cursor=3100
      // is in [1000, 9000] so only anchor@1000 is legal (others are past it).
      const refreshFirst = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 3100),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(refreshFirst.cacheMissExpected).toBe(false)
      expect(refreshFirst.prefixStart).toBe(1000)
      // Add a 5th region. cursor=42000 — 42000-28000=14000 > MAX so even the
      // newest existing anchor is illegal. Slots full → LRU evicts the
      // least-recently-used one (which is anchor@10000: anchor@1000 was just
      // refreshed, so it's the most-recently used).
      mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 42000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      // Returning to region 2 (the 10000 anchor's area) must miss — evicted.
      const returnToEvicted = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 12100),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(returnToEvicted.cacheMissExpected).toBe(true)
      // Returning to region 1 still hits — anchor@1000 was protected by the
      // touch above.
      const returnToRegion1 = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 3200),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(returnToRegion1.cacheMissExpected).toBe(false)
      expect(returnToRegion1.prefixStart).toBe(1000)
    })

    it("per-file isolation: anchors for /a.md don't serve /b.md", () => {
      const mgr = new VoicePrefixCacheManager()
      const docA = genText(10, 10000)
      const docB = genText(11, 10000)
      mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: docA.slice(0, 5000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      const inB = mgr.pickBeforeSlice({
        filePath: '/b.md',
        fullDocBefore: docB.slice(0, 5000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(inB.cacheMissExpected).toBe(true)
    })

    it('picks the widest legal anchor (smallest prefixStart) when multiple are valid', () => {
      const mgr = new VoicePrefixCacheManager({ slotsPerFile: 4 })
      const doc = genText(12, 20000)
      // Anchor at offsets 0 (cursor=1500), 3000 (cursor=5000)
      mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 1500), // anchor=max(0,1500-2000)=0
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 5000), // anchor=3000
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      // At cursor 5100, BOTH anchors are legal. Manager must pick anchor=0
      // (longest slice).
      const wide = mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 5100),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      expect(wide.cacheMissExpected).toBe(false)
      expect(wide.prefixStart).toBe(0)
      expect(wide.slice.length).toBe(5100)
    })
  })

  describe('housekeeping', () => {
    it("forget(path) removes the file's entries; other files unaffected", () => {
      const mgr = new VoicePrefixCacheManager()
      const doc = genText(13, 5000)
      mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 3000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      mgr.pickBeforeSlice({
        filePath: '/b.md',
        fullDocBefore: doc.slice(0, 3000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      mgr.forget('/a.md')
      // /a.md cold again
      expect(
        mgr.pickBeforeSlice({
          filePath: '/a.md',
          fullDocBefore: doc.slice(0, 3500),
          minPrefixChars: MIN,
          maxPrefixChars: MAX,
        }).cacheMissExpected,
      ).toBe(true)
      // /b.md still warm
      expect(
        mgr.pickBeforeSlice({
          filePath: '/b.md',
          fullDocBefore: doc.slice(0, 3500),
          minPrefixChars: MIN,
          maxPrefixChars: MAX,
        }).cacheMissExpected,
      ).toBe(false)
    })

    it('forget(folder) cascades to every child path', () => {
      const mgr = new VoicePrefixCacheManager()
      const doc = genText(14, 5000)
      mgr.pickBeforeSlice({
        filePath: '/notes/a.md',
        fullDocBefore: doc.slice(0, 3000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      mgr.pickBeforeSlice({
        filePath: '/notes/sub/b.md',
        fullDocBefore: doc.slice(0, 3000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      mgr.pickBeforeSlice({
        filePath: '/other.md',
        fullDocBefore: doc.slice(0, 3000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      mgr.forget('/notes')
      // Both /notes paths cold
      expect(
        mgr.pickBeforeSlice({
          filePath: '/notes/a.md',
          fullDocBefore: doc.slice(0, 3500),
          minPrefixChars: MIN,
          maxPrefixChars: MAX,
        }).cacheMissExpected,
      ).toBe(true)
      expect(
        mgr.pickBeforeSlice({
          filePath: '/notes/sub/b.md',
          fullDocBefore: doc.slice(0, 3500),
          minPrefixChars: MIN,
          maxPrefixChars: MAX,
        }).cacheMissExpected,
      ).toBe(true)
      // /other.md untouched
      expect(
        mgr.pickBeforeSlice({
          filePath: '/other.md',
          fullDocBefore: doc.slice(0, 3500),
          minPrefixChars: MIN,
          maxPrefixChars: MAX,
        }).cacheMissExpected,
      ).toBe(false)
    })

    it('clear() wipes everything', () => {
      const mgr = new VoicePrefixCacheManager()
      const doc = genText(15, 5000)
      mgr.pickBeforeSlice({
        filePath: '/a.md',
        fullDocBefore: doc.slice(0, 3000),
        minPrefixChars: MIN,
        maxPrefixChars: MAX,
      })
      mgr.clear()
      expect(
        mgr.pickBeforeSlice({
          filePath: '/a.md',
          fullDocBefore: doc.slice(0, 3500),
          minPrefixChars: MIN,
          maxPrefixChars: MAX,
        }).cacheMissExpected,
      ).toBe(true)
    })
  })
})
