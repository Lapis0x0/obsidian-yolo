import type { SrsCardState } from '../../domain/srs/srsTypes'

import { buildAnkiImportPlan, renameAnkiImportPlan } from './importPlan'
import type { ParsedAnkiImport } from './ports'

const storedCard = (reviewedAt: number): SrsCardState => ({
  due: new Date(reviewedAt + 1).toISOString(),
  stability: 1,
  difficulty: 2,
  elapsedDays: 0,
  scheduledDays: 1,
  learningSteps: 0,
  reps: 1,
  lapses: 0,
  state: 2,
  lastReview: new Date(reviewedAt).toISOString(),
  introducedAt: new Date(reviewedAt).toISOString(),
})

const parsed = (): ParsedAnkiImport => ({
  format: 'modern',
  decks: [
    { id: 1, name: 'Deck::One', path: ['Deck', 'One'] },
    { id: 2, name: 'Deck::Two', path: ['Deck', 'Two'] },
  ],
  notes: [
    {
      cards: [
        {
          id: 10,
          noteId: 1,
          deckId: 1,
          templateOrdinal: 0,
          front: '**Question** {{anki-media:image:Pic.PNG}}',
          back: 'Answer',
          queue: -1,
          suspended: true,
        },
        {
          id: 11,
          noteId: 2,
          deckId: 2,
          templateOrdinal: 0,
          front: '',
          back: 'New',
          queue: 0,
          suspended: false,
        },
      ],
    },
  ],
  mediaFiles: { 'Pic.PNG': Uint8Array.from([1, 2, 3]) },
  srsPlan: {
    eventsByCard: {
      '10': [{ cardId: 10, reviewedAt: 10_000, rating: 3, intervalDays: 1 }],
    },
  },
  warnings: ['warning'],
})

describe('Anki import plan', () => {
  it('preserves card identity coordination, hashed media, slugs and SRS replay', async () => {
    const replay = jest.fn((events: readonly { reviewedAt: number }[]) =>
      storedCard(events[0].reviewedAt),
    )
    const plan = await buildAnkiImportPlan({
      parsed: parsed(),
      baseDir: 'Learning/',
      existingProjectSlugs: ['Deck'],
      srsReplay: { replay },
    })

    expect(plan.projectSlug).toBe('Deck-2')
    expect(plan.projectPath).toBe('Learning/Deck-2')
    expect(plan.chapters.map((chapter) => chapter.slug)).toEqual(['One', 'Two'])
    expect(plan.chapters[0].cards[0]).toMatchObject({ title: 'Question' })
    expect(plan.chapters[1].cards[0]).toMatchObject({ title: 'Untitled card' })
    expect(
      new Set(
        plan.chapters.flatMap((chapter) =>
          chapter.cards.map((card) => card.uuid),
        ),
      ).size,
    ).toBe(2)
    expect(plan.chapters[0].cards[0].uuid).toMatch(/^[a-f\d]{8}$/)
    expect(plan.srsState.suspended).toEqual([plan.chapters[0].cards[0].uuid])
    expect(plan.srsState.lastStudiedAt).toBe(new Date(10_000).toISOString())
    expect(replay).toHaveBeenCalledTimes(1)
    expect(plan.assets[0].fileName).toMatch(/^[a-f\d]{64}\.png$/)
    expect(Object.isFrozen(plan)).toBe(true)
  })

  it('renames the project without changing card UUIDs or media paths', async () => {
    const plan = await buildAnkiImportPlan({
      parsed: parsed(),
      baseDir: 'Learning',
      existingProjectSlugs: [],
      srsReplay: { replay: (events) => storedCard(events[0].reviewedAt) },
    })
    const renamed = renameAnkiImportPlan({
      plan,
      projectName: 'Renamed',
      existingProjectSlugs: ['Renamed'],
    })

    expect(renamed.projectPath).toBe('Learning/Renamed-2')
    expect(
      renamed.chapters.flatMap((chapter) =>
        chapter.cards.map((card) => card.uuid),
      ),
    ).toEqual(
      plan.chapters.flatMap((chapter) =>
        chapter.cards.map((card) => card.uuid),
      ),
    )
    expect(renamed.assets).toEqual(plan.assets)
  })
})
