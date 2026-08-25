import { planNoteCardSelfHeal } from './selfHeal'

describe('planNoteCardSelfHeal', () => {
  it('relocates a card whose backing file has exactly one same-basename match elsewhere', () => {
    const missing = [{ cardId: 'c1', file: 'Old/Note.md' }]
    const markdownFiles = [{ path: 'New/Note.md', name: 'Note.md' }]
    expect(planNoteCardSelfHeal(missing, markdownFiles)).toEqual([
      { cardId: 'c1', file: 'New/Note.md' },
    ])
  })

  it('leaves a card alone when there are zero basename matches', () => {
    const missing = [{ cardId: 'c1', file: 'Old/Note.md' }]
    const markdownFiles = [{ path: 'New/Other.md', name: 'Other.md' }]
    expect(planNoteCardSelfHeal(missing, markdownFiles)).toEqual([])
  })

  it('leaves a card alone when there are multiple basename matches (ambiguous)', () => {
    const missing = [{ cardId: 'c1', file: 'Old/Note.md' }]
    const markdownFiles = [
      { path: 'A/Note.md', name: 'Note.md' },
      { path: 'B/Note.md', name: 'Note.md' },
    ]
    expect(planNoteCardSelfHeal(missing, markdownFiles)).toEqual([])
  })

  it('does not "relocate" a card to the same path it already has', () => {
    const missing = [{ cardId: 'c1', file: 'Same/Note.md' }]
    const markdownFiles = [{ path: 'Same/Note.md', name: 'Note.md' }]
    expect(planNoteCardSelfHeal(missing, markdownFiles)).toEqual([])
  })

  it('handles multiple missing cards independently', () => {
    const missing = [
      { cardId: 'c1', file: 'Old/A.md' },
      { cardId: 'c2', file: 'Old/B.md' },
    ]
    const markdownFiles = [
      { path: 'New/A.md', name: 'A.md' },
      { path: 'X/B.md', name: 'B.md' },
      { path: 'Y/B.md', name: 'B.md' },
    ]
    expect(planNoteCardSelfHeal(missing, markdownFiles)).toEqual([
      { cardId: 'c1', file: 'New/A.md' },
    ])
  })

  it('returns an empty array for no missing cards', () => {
    expect(planNoteCardSelfHeal([], [{ path: 'A.md', name: 'A.md' }])).toEqual(
      [],
    )
  })
})
