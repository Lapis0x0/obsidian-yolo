import { ChangeSet, Text } from '@codemirror/state'

import {
  type ReviewSuggestion,
  buildReviewPlanFromEdits,
  buildSnapshotReviewPlan,
  resolveSuggestionChange,
  switchReviewSuggestionSide,
  updateReviewSuggestions,
} from './review-model'

const createSuggestion = (
  overrides: Partial<ReviewSuggestion>,
): ReviewSuggestion => ({
  id: 0,
  from: 2,
  to: 5,
  startLine: 0,
  endLine: 0,
  originalText: 'old',
  modifiedText: 'new',
  activeSide: 'modified',
  originalValue: 'old',
  modifiedValue: 'new',
  ...overrides,
})

const applyChanges = (content: string, changes: ChangeSet): string =>
  changes.apply(Text.of(content.split('\n'))).toString()

describe('review plan materialization', () => {
  it('materializes exact edits and points suggestions into proposed text', () => {
    const original = 'A\nold\nB'
    const plan = buildReviewPlanFromEdits(original, [
      { from: 2, to: 5, replacement: 'editable\nproposal' },
    ])

    expect(plan).not.toBeNull()
    expect(plan?.content).toBe('A\neditable\nproposal\nB')
    expect(plan?.suggestions[0]).toMatchObject({
      from: 2,
      to: 19,
      originalText: 'old',
      modifiedText: 'editable\nproposal',
      activeSide: 'modified',
      originalValue: 'old',
      modifiedValue: 'editable\nproposal',
    })
  })

  it('splits paired paragraphs while preserving a reconstructable plan', () => {
    const original = ['Old one', '', 'Old two', '', 'Old three'].join('\n')
    const replacement = ['新一', '', '新二', '', '新三'].join('\n')
    const plan = buildReviewPlanFromEdits(original, [
      { from: 0, to: original.length, replacement },
    ])

    expect(plan?.content).toBe(replacement)
    expect(
      applyChanges(
        original,
        ChangeSet.of(plan?.changes ?? [], original.length),
      ),
    ).toBe(replacement)
    expect(plan?.suggestions).toHaveLength(3)
    expect(
      plan?.suggestions.map((suggestion) => [
        suggestion.originalValue,
        suggestion.modifiedValue,
      ]),
    ).toEqual([
      ['Old one', '新一'],
      ['Old two', '新二'],
      ['Old three', '新三'],
    ])
  })

  it('rejects overlapping or invalid exact edit ranges', () => {
    expect(
      buildReviewPlanFromEdits('abcdef', [
        { from: 1, to: 4, replacement: 'X' },
        { from: 3, to: 5, replacement: 'Y' },
      ]),
    ).toBeNull()
  })

  it.each([
    ['empty document insertion', '', 'first'],
    ['replacement', 'A\nold\nB', 'A\nnew\nB'],
    ['middle insertion', 'A\nB', 'A\nX\nB'],
    ['prepend', 'B', 'A\nB'],
    ['append at EOF', 'A', 'A\nB'],
    ['middle deletion', 'A\nX\nB', 'A\nB'],
    ['first-line deletion', 'X\nB', 'B'],
    ['last-line deletion', 'A\nX', 'A'],
    ['multiple changes', 'one\ntwo\nthree\nfour', 'ONE\ntwo\ninserted\nthree'],
  ])(
    'reconstructs the incoming document for %s',
    (_name, original, incoming) => {
      expect(buildSnapshotReviewPlan(original, incoming).content).toBe(incoming)
    },
  )

  it('represents insertion with a real proposed range and deletion with an anchor', () => {
    const insertion = buildSnapshotReviewPlan('A', 'A\nB').suggestions[0]
    const deletion = buildSnapshotReviewPlan('A\nB', 'A').suggestions[0]

    expect(insertion).toMatchObject({
      from: 1,
      to: 3,
      originalText: '',
      originalValue: undefined,
    })
    expect(deletion.from).toBe(deletion.to)
    expect(deletion.originalText).toBe('\nB')
  })

  it('uses the same current-text ranges for an already-applied review', () => {
    const original = 'before\nold\nafter'
    const applied = 'before\nagent text\nafter'
    const plan = buildSnapshotReviewPlan(original, applied)
    const suggestion = plan.suggestions[0]
    const rejection = resolveSuggestionChange(applied, suggestion)

    expect(plan.content).toBe(applied)
    expect(
      `${applied.slice(0, rejection.from)}${rejection.insert}${applied.slice(rejection.to)}`,
    ).toBe(original)
  })

  it('falls back to a whole-document edit instead of diffing a huge file', () => {
    // vscode-diff 的行对齐在大输入上不接受 timeout，实测 20000 行全量重写要
    // 17 秒。超限时不跑 diff，改用整篇替换，评审计划仍然可用、可还原。
    const original = Array.from(
      { length: 5001 },
      (_, i) => `原始第 ${i} 行`,
    ).join('\n')
    const incoming = Array.from(
      { length: 5001 },
      (_, i) => `修改第 ${i} 行`,
    ).join('\n')

    const started = Date.now()
    const plan = buildSnapshotReviewPlan(original, incoming)
    const elapsed = Date.now() - started

    expect(plan.content).toBe(incoming)
    expect(plan.suggestions.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(500)

    const restore = ChangeSet.of(
      plan.suggestions.map((suggestion) =>
        resolveSuggestionChange(plan.content, suggestion),
      ),
      plan.content.length,
    )
    expect(applyChanges(plan.content, restore)).toBe(original)
  })

  it('reports no suggestions when huge content is identical', () => {
    const huge = Array.from({ length: 5001 }, (_, i) => `第 ${i} 行`).join('\n')
    expect(buildSnapshotReviewPlan(huge, huge).suggestions).toEqual([])
  })

  it('restores every pending item from materialized ranges', () => {
    const original = 'one\ntwo\nthree\nfour'
    const plan = buildSnapshotReviewPlan(original, 'ONE\ntwo\ninserted\nthree')
    const restore = ChangeSet.of(
      plan.suggestions.map((suggestion) =>
        resolveSuggestionChange(plan.content, suggestion),
      ),
      plan.content.length,
    )

    expect(applyChanges(plan.content, restore)).toBe(original)
  })
})

describe('editable review drafts', () => {
  it('switches the live range without resolving the suggestion', () => {
    const suggestion = createSuggestion({})
    const changes = ChangeSet.of({ from: 2, to: 5, insert: 'old' }, 8)

    expect(
      switchReviewSuggestionSide(
        [suggestion],
        suggestion.id,
        'original',
        changes,
      ),
    ).toEqual([
      {
        ...suggestion,
        activeSide: 'original',
        from: 2,
        to: 5,
      },
    ])
  })

  it('updates only the active draft and can still resolve to either side', () => {
    const switched = createSuggestion({ activeSide: 'original' })
    const content = 'xxoldyyy'
    const changes = ChangeSet.of({ from: 3, to: 4, insert: 'LDER' }, 8)
    const edited = applyChanges(content, changes)
    const pending = updateReviewSuggestions([switched], changes, edited)
      .suggestions[0]

    expect(pending).toMatchObject({
      originalText: 'oLDERd',
      modifiedText: 'new',
      activeSide: 'original',
    })
    expect(resolveSuggestionChange(edited, pending, 'original').insert).toBe(
      'oLDERd',
    )
    expect(resolveSuggestionChange(edited, pending, 'modified').insert).toBe(
      'new',
    )
  })
})

describe('pending range updates', () => {
  it('keeps and expands one suggestion for an internal edit', () => {
    const suggestion = createSuggestion({})
    const changes = ChangeSet.of({ from: 3, to: 4, insert: 'long' }, 8)

    expect(updateReviewSuggestions([suggestion], changes)).toEqual({
      suggestions: [{ ...suggestion, from: 2, to: 8 }],
      removedIds: [],
    })
  })

  it('keeps a whole-range replacement inside the same suggestion', () => {
    const suggestion = createSuggestion({})
    const changes = ChangeSet.of({ from: 2, to: 5, insert: 'x' }, 8)

    expect(updateReviewSuggestions([suggestion], changes)).toEqual({
      suggestions: [{ ...suggestion, from: 2, to: 3 }],
      removedIds: [],
    })
  })

  it('does not absorb insertions at either boundary', () => {
    const suggestion = createSuggestion({})
    const content = 'xxnewyyy'
    const changes = ChangeSet.of(
      [
        { from: 2, insert: 'before' },
        { from: 5, insert: 'after' },
      ],
      8,
    )

    const result = updateReviewSuggestions([suggestion], changes)
    expect(result).toEqual({
      suggestions: [{ ...suggestion, from: 8, to: 11 }],
      removedIds: [],
    })
    const edited = applyChanges(content, changes)
    const rejection = resolveSuggestionChange(edited, result.suggestions[0])
    expect(
      `${edited.slice(0, rejection.from)}${rejection.insert}${edited.slice(rejection.to)}`,
    ).toBe('xxbeforeoldafteryyy')
  })

  it('removes a suggestion for a cross-boundary edit', () => {
    const suggestion = createSuggestion({})
    const changes = ChangeSet.of({ from: 1, to: 3, insert: 'x' }, 8)

    expect(updateReviewSuggestions([suggestion], changes)).toEqual({
      suggestions: [],
      removedIds: [0],
    })
  })

  it('removes every touched suggestion when one transaction edits multiple items', () => {
    const first = createSuggestion({ id: 1, from: 1, to: 3 })
    const second = createSuggestion({ id: 2, from: 6, to: 8 })
    const changes = ChangeSet.of(
      [
        { from: 2, insert: 'x' },
        { from: 7, insert: 'y' },
      ],
      10,
    )

    expect(updateReviewSuggestions([first, second], changes)).toEqual({
      suggestions: [],
      removedIds: [1, 2],
    })
  })

  it('maps untouched items and preserves the user edit', () => {
    const suggestion = createSuggestion({})
    const content = 'xxnewyyy'
    const changes = ChangeSet.of({ from: 0, to: 0, insert: 'prefix' }, 8)
    const result = updateReviewSuggestions([suggestion], changes)

    expect(applyChanges(content, changes)).toBe('prefixxxnewyyy')
    expect(result.suggestions[0]).toMatchObject({ from: 8, to: 11 })
  })

  it('keeps an insertion at a pure-deletion anchor outside the item', () => {
    const suggestion = createSuggestion({ from: 2, to: 2 })
    const changes = ChangeSet.of({ from: 2, insert: 'user' }, 5)

    expect(updateReviewSuggestions([suggestion], changes)).toEqual({
      suggestions: [suggestion],
      removedIds: [],
    })

    const edited = applyChanges('abxyz', changes)
    const rejection = resolveSuggestionChange(edited, suggestion)
    expect(
      `${edited.slice(0, rejection.from)}${rejection.insert}${edited.slice(rejection.to)}`,
    ).toBe('abolduserxyz')
  })

  it('drops internal manual edits when rejection restores source text', () => {
    const original = 'A\nold\nB'
    const plan = buildSnapshotReviewPlan(original, 'A\nproposal\nB')
    const initial = plan.suggestions[0]
    const changes = ChangeSet.of(
      { from: initial.from + 1, to: initial.to - 1, insert: 'EDITED' },
      plan.content.length,
    )
    const editedContent = applyChanges(plan.content, changes)
    const pending = updateReviewSuggestions([initial], changes).suggestions[0]
    const rejection = resolveSuggestionChange(editedContent, pending)
    const rejected = `${editedContent.slice(0, rejection.from)}${rejection.insert}${editedContent.slice(rejection.to)}`

    expect(rejected).toBe(original)
  })
})
