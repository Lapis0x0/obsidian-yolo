import {
  type ActualChunk,
  type DesiredChunk,
  planReconcile,
} from './reconciler'

const desired = (
  path: string,
  startLine: number,
  endLine: number,
  contentHash: string,
  options: { page?: number; mtime?: number; content?: string } = {},
): DesiredChunk => ({
  path,
  content: options.content ?? `content-${path}-${startLine}`,
  contentHash,
  metadata: {
    startLine,
    endLine,
    ...(options.page ? { page: options.page } : {}),
  },
  mtime: options.mtime ?? 1000,
})

const actual = (
  id: number,
  path: string,
  startLine: number,
  endLine: number,
  contentHash: string | null,
  options: { page?: number; mtime?: number } = {},
): ActualChunk => ({
  id,
  path,
  contentHash,
  metadata: {
    startLine,
    endLine,
    ...(options.page ? { page: options.page } : {}),
  },
  mtime: options.mtime ?? 1000,
})

describe('planReconcile', () => {
  it('embeds new chunks and deletes nothing when actual is empty', () => {
    const plan = planReconcile([desired('a.md', 1, 3, 'h1')], [])
    expect(plan.toEmbed).toHaveLength(1)
    expect(plan.toDeleteIds).toEqual([])
    expect(plan.toBumpMtime).toEqual([])
    expect(plan.reusedCount).toBe(0)
  })

  it('reuses chunks when identity and content hash match', () => {
    const plan = planReconcile(
      [desired('a.md', 1, 3, 'h1', { mtime: 2000 })],
      [actual(7, 'a.md', 1, 3, 'h1', { mtime: 2000 })],
    )
    expect(plan.toEmbed).toEqual([])
    expect(plan.toDeleteIds).toEqual([])
    expect(plan.toBumpMtime).toEqual([])
    expect(plan.reusedCount).toBe(1)
  })

  it('bumps mtime when content matches but mtime differs', () => {
    const plan = planReconcile(
      [desired('a.md', 1, 3, 'h1', { mtime: 2000 })],
      [actual(7, 'a.md', 1, 3, 'h1', { mtime: 1000 })],
    )
    expect(plan.toEmbed).toEqual([])
    expect(plan.toDeleteIds).toEqual([])
    expect(plan.toBumpMtime).toEqual([{ id: 7, mtime: 2000 }])
    expect(plan.reusedCount).toBe(1)
  })

  it('replaces a chunk whose content hash changed at the same identity', () => {
    const plan = planReconcile(
      [desired('a.md', 1, 3, 'NEW')],
      [actual(7, 'a.md', 1, 3, 'OLD')],
    )
    expect(plan.toEmbed).toHaveLength(1)
    expect(plan.toDeleteIds).toEqual([7])
    expect(plan.reusedCount).toBe(0)
  })

  it('deletes actual rows whose identity is no longer desired (file removed from scope)', () => {
    const plan = planReconcile(
      [],
      [actual(7, 'a.md', 1, 3, 'h1'), actual(8, 'a.md', 4, 6, 'h2')],
    )
    expect(plan.toDeleteIds.sort()).toEqual([7, 8])
    expect(plan.toEmbed).toEqual([])
  })

  it('handles a renamed-or-shifted chunk: same hash, different line range, in the same file', () => {
    // Identity changed, so old row at lines 1-3 is deleted, new row at 4-6
    // is embedded. Note: the planner does not try to "move" rows because
    // the embedding is path+line addressed downstream.
    const plan = planReconcile(
      [desired('a.md', 4, 6, 'h1')],
      [actual(7, 'a.md', 1, 3, 'h1')],
    )
    expect(plan.toDeleteIds).toEqual([7])
    expect(plan.toEmbed).toHaveLength(1)
  })

  it('treats pdf chunks distinct from md chunks at same line range via page metadata', () => {
    const plan = planReconcile(
      [desired('a.pdf', 1, 5, 'hP', { page: 2 })],
      [actual(7, 'a.pdf', 1, 5, 'hP', { page: 1 })],
    )
    // page differs → identity differs → page-1 row is deleted, page-2 is embedded.
    expect(plan.toDeleteIds).toEqual([7])
    expect(plan.toEmbed).toHaveLength(1)
  })

  it('drops duplicate actual rows for the same identity, keeping one matching hash', () => {
    const plan = planReconcile(
      [desired('a.md', 1, 3, 'h1')],
      [
        actual(7, 'a.md', 1, 3, 'h1'),
        actual(8, 'a.md', 1, 3, 'h1'),
        actual(9, 'a.md', 1, 3, 'STALE'),
      ],
    )
    // One row with matching hash is kept (reused), the other two deleted.
    expect(plan.reusedCount).toBe(1)
    expect(plan.toDeleteIds.sort()).toEqual([8, 9])
    expect(plan.toEmbed).toEqual([])
  })

  it('mixes deletion and embedding across multiple files', () => {
    const plan = planReconcile(
      [
        desired('a.md', 1, 3, 'h1'),
        desired('b.md', 1, 5, 'h2'),
        desired('c.md', 1, 2, 'h3'),
      ],
      [
        actual(1, 'a.md', 1, 3, 'h1'),
        actual(2, 'a.md', 4, 6, 'oldChunk'),
        actual(3, 'b.md', 1, 5, 'h2-OLD'),
        actual(4, 'd.md', 1, 1, 'gone'),
      ],
    )
    expect(plan.reusedCount).toBe(1) // a.md 1-3
    expect(plan.toDeleteIds.sort((x, y) => x - y)).toEqual([2, 3, 4])
    expect(plan.toEmbed.map((c) => c.path).sort()).toEqual(['b.md', 'c.md'])
  })

  it('null content hash on actual is treated as never matching', () => {
    const plan = planReconcile(
      [desired('a.md', 1, 3, 'h1')],
      [actual(7, 'a.md', 1, 3, null)],
    )
    expect(plan.toDeleteIds).toEqual([7])
    expect(plan.toEmbed).toHaveLength(1)
  })
})
