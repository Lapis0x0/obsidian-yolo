import {
  type ReviewSuggestion,
  buildReviewSuggestionsFromEdits,
  buildSnapshotReviewSuggestions,
  resolveSuggestionChange,
} from './review-model'

const createSuggestion = (
  overrides: Partial<ReviewSuggestion>,
): ReviewSuggestion => ({
  id: 0,
  from: 0,
  to: 0,
  displayFrom: 0,
  displayTo: 0,
  insert: '',
  startLine: 0,
  endLine: 0,
  originalValue: undefined,
  modifiedValue: undefined,
  ...overrides,
})

const applySuggestions = (
  content: string,
  suggestions: ReviewSuggestion[],
): string => {
  return [...suggestions]
    .sort((left, right) => right.from - left.from)
    .reduce((current, suggestion) => {
      const change = resolveSuggestionChange(current, suggestion)
      return `${current.slice(0, change.from)}${change.insert}${current.slice(change.to)}`
    }, content)
}

describe('buildReviewSuggestionsFromEdits', () => {
  it('splits a structured three-paragraph replacement into paired suggestions', () => {
    const original = ['Old one', '', 'Old two', '', 'Old three'].join('\n')
    const replacement = ['新一', '', '新二', '', '新三'].join('\n')

    const suggestions = buildReviewSuggestionsFromEdits(original, [
      { from: 0, to: original.length, replacement },
    ])

    expect(suggestions).toHaveLength(3)
    expect(
      suggestions?.map((suggestion) => [
        suggestion.originalValue,
        suggestion.modifiedValue,
      ]),
    ).toEqual([
      ['Old one', '新一'],
      ['Old two', '新二'],
      ['Old three', '新三'],
    ])
    expect(applySuggestions(original, suggestions ?? [])).toBe(replacement)
  })

  it('keeps paragraph pairing when only trailing blank lines differ', () => {
    const original = `${['Old one', '', 'Old two', '', 'Old three'].join('\n')}\n`
    const replacement = `${['新一', '', '新二', '', '新三'].join('\n')}\n\n\n`

    const suggestions = buildReviewSuggestionsFromEdits(original, [
      { from: 0, to: original.length, replacement },
    ])

    expect(suggestions).toHaveLength(3)
    expect(suggestions?.map((suggestion) => suggestion.modifiedValue)).toEqual([
      '新一',
      '新二',
      '新三',
    ])
    expect(applySuggestions(original, suggestions ?? [])).toBe(replacement)
  })

  it('keeps structurally ambiguous replacements as one suggestion', () => {
    const original = ['Old one', '', 'Old two'].join('\n')
    const replacement = ['新一', '', '新二', '', '新三'].join('\n')

    const suggestions = buildReviewSuggestionsFromEdits(original, [
      { from: 0, to: original.length, replacement },
    ])

    expect(suggestions).toHaveLength(1)
    expect(applySuggestions(original, suggestions ?? [])).toBe(replacement)
  })

  it('rejects overlapping or invalid exact edit ranges', () => {
    expect(
      buildReviewSuggestionsFromEdits('abcdef', [
        { from: 1, to: 4, replacement: 'X' },
        { from: 3, to: 5, replacement: 'Y' },
      ]),
    ).toBeNull()
  })
})

describe('buildSnapshotReviewSuggestions', () => {
  it('uses whole-line replacements instead of token fragments', () => {
    const suggestions = buildSnapshotReviewSuggestions(
      '今天去公园散步，然后买咖啡。',
      '今天去公园慢跑，然后买热咖啡。',
    )

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      originalValue: '今天去公园散步，然后买咖啡。',
      modifiedValue: '今天去公园慢跑，然后买热咖啡。',
    })
  })

  it('pairs equal paragraph structures even without shared language anchors', () => {
    const original = ['Old one', '', 'Old two', '', 'Old three'].join('\n')
    const incoming = ['新一', '', '新二', '', '新三'].join('\n')
    const suggestions = buildSnapshotReviewSuggestions(original, incoming)

    expect(suggestions).toHaveLength(3)
    expect(suggestions.map((suggestion) => suggestion.modifiedValue)).toEqual([
      '新一',
      '新二',
      '新三',
    ])
    expect(applySuggestions(original, suggestions)).toBe(incoming)
  })

  it.each([
    ['replacement', 'A\nold\nB', 'A\nnew\nB'],
    ['middle insertion', 'A\nB', 'A\nX\nB'],
    ['prepend', 'B', 'A\nB'],
    ['append', 'A', 'A\nB'],
    ['middle deletion', 'A\nX\nB', 'A\nB'],
    ['first-line deletion', 'X\nB', 'B'],
    ['last-line deletion', 'A\nX', 'A'],
    ['multiple changes', 'one\ntwo\nthree\nfour', 'ONE\ntwo\ninserted\nthree'],
  ])(
    'reconstructs the incoming document for %s',
    (_name, current, incoming) => {
      const suggestions = buildSnapshotReviewSuggestions(current, incoming)
      expect(applySuggestions(current, suggestions)).toBe(incoming)
    },
  )
})

describe('resolveSuggestionChange', () => {
  it('replaces the latest mapped range with the fixed suggestion', () => {
    const suggestion = createSuggestion({
      from: 2,
      to: 9,
      insert: 'suggested',
      originalValue: 'old',
      modifiedValue: 'suggested',
    })

    expect(resolveSuggestionChange('A\nedited\nB', suggestion)).toEqual({
      from: 2,
      to: 9,
      insert: 'suggested',
    })
  })
})
