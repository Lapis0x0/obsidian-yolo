import { planFileNodeSelfHeal } from './selfHeal'

describe('planFileNodeSelfHeal', () => {
  it('relocates a node whose backing file has exactly one same-basename match elsewhere', () => {
    const missing = [{ nodeId: 'c1', file: 'Old/Note.md' }]
    const markdownFiles = [{ path: 'New/Note.md', name: 'Note.md' }]
    expect(planFileNodeSelfHeal(missing, markdownFiles)).toEqual([
      { nodeId: 'c1', file: 'New/Note.md' },
    ])
  })

  it('leaves a node alone when there are zero basename matches', () => {
    const missing = [{ nodeId: 'c1', file: 'Old/Note.md' }]
    const markdownFiles = [{ path: 'New/Other.md', name: 'Other.md' }]
    expect(planFileNodeSelfHeal(missing, markdownFiles)).toEqual([])
  })

  it('leaves a node alone when there are multiple basename matches (ambiguous)', () => {
    const missing = [{ nodeId: 'c1', file: 'Old/Note.md' }]
    const markdownFiles = [
      { path: 'A/Note.md', name: 'Note.md' },
      { path: 'B/Note.md', name: 'Note.md' },
    ]
    expect(planFileNodeSelfHeal(missing, markdownFiles)).toEqual([])
  })

  it('does not "relocate" a node to the same path it already has', () => {
    const missing = [{ nodeId: 'c1', file: 'Same/Note.md' }]
    const markdownFiles = [{ path: 'Same/Note.md', name: 'Note.md' }]
    expect(planFileNodeSelfHeal(missing, markdownFiles)).toEqual([])
  })

  it('handles multiple missing nodes independently', () => {
    const missing = [
      { nodeId: 'c1', file: 'Old/A.md' },
      { nodeId: 'c2', file: 'Old/B.md' },
    ]
    const markdownFiles = [
      { path: 'New/A.md', name: 'A.md' },
      { path: 'X/B.md', name: 'B.md' },
      { path: 'Y/B.md', name: 'B.md' },
    ]
    expect(planFileNodeSelfHeal(missing, markdownFiles)).toEqual([
      { nodeId: 'c1', file: 'New/A.md' },
    ])
  })

  it('returns an empty array for no missing nodes', () => {
    expect(planFileNodeSelfHeal([], [{ path: 'A.md', name: 'A.md' }])).toEqual(
      [],
    )
  })
})
