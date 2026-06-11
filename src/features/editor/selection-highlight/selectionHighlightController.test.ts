import { EditorSelection } from '@codemirror/state'

import {
  type SelectionHighlightPayloadEntry,
  shouldHideNativeSelection,
  shouldPaintPersistedHighlight,
} from './selectionHighlightController'

function selection(from: number, to: number): EditorSelection {
  return EditorSelection.create([EditorSelection.range(from, to)])
}

function entry(
  overrides: Partial<SelectionHighlightPayloadEntry> &
    Pick<SelectionHighlightPayloadEntry, 'variant' | 'from' | 'to'>,
): SelectionHighlightPayloadEntry {
  return {
    id: 'test-id',
    visual: 'selection',
    ...overrides,
  }
}

describe('shouldHideNativeSelection', () => {
  it('returns false for an empty payload', () => {
    expect(shouldHideNativeSelection([], selection(0, 5))).toBe(false)
  })

  it('returns false while the primary pointer button is down', () => {
    const payload = [entry({ variant: 'sync', from: 0, to: 5 })]
    expect(shouldHideNativeSelection(payload, selection(10, 20), true)).toBe(
      false,
    )
  })

  it('returns true when any sync highlight exists', () => {
    const payload = [entry({ variant: 'sync', from: 0, to: 5 })]
    expect(shouldHideNativeSelection(payload, selection(10, 20))).toBe(true)
  })

  it('returns true when pinned range exactly matches the live selection', () => {
    const payload = [entry({ variant: 'pinned', from: 3, to: 9 })]
    expect(shouldHideNativeSelection(payload, selection(3, 9))).toBe(true)
  })

  it('returns false when pinned range does not match the live selection', () => {
    const payload = [entry({ variant: 'pinned', from: 3, to: 9 })]
    expect(shouldHideNativeSelection(payload, selection(3, 10))).toBe(false)
    expect(shouldHideNativeSelection(payload, selection(10, 20))).toBe(false)
  })

  it('returns false for pinned highlights when the selection is empty', () => {
    const payload = [entry({ variant: 'pinned', from: 3, to: 9 })]
    expect(
      shouldHideNativeSelection(
        payload,
        EditorSelection.create([EditorSelection.cursor(0)]),
      ),
    ).toBe(false)
  })

  it('returns true for mixed sync and pinned payloads', () => {
    const payload = [
      entry({ variant: 'pinned', from: 1, to: 4 }),
      entry({ variant: 'sync', from: 10, to: 20 }),
    ]
    expect(shouldHideNativeSelection(payload, selection(1, 4))).toBe(true)
  })
})

describe('shouldPaintPersistedHighlight', () => {
  it('returns false for sync highlights while pointer is down', () => {
    const payload = entry({ variant: 'sync', from: 0, to: 5 })
    expect(shouldPaintPersistedHighlight(payload, selection(0, 5), true)).toBe(
      false,
    )
  })

  it('returns false for pinned highlights matching live selection while pointer is down', () => {
    const payload = entry({ variant: 'pinned', from: 3, to: 9 })
    expect(shouldPaintPersistedHighlight(payload, selection(3, 9), true)).toBe(
      false,
    )
  })

  it('returns true for non-matching pinned highlights while pointer is down', () => {
    const payload = entry({ variant: 'pinned', from: 3, to: 9 })
    expect(
      shouldPaintPersistedHighlight(payload, selection(10, 20), true),
    ).toBe(true)
  })

  it('returns true once the pointer is released', () => {
    const payload = entry({ variant: 'sync', from: 0, to: 5 })
    expect(shouldPaintPersistedHighlight(payload, selection(0, 5), false)).toBe(
      true,
    )
  })
})
