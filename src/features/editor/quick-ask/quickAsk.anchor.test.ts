import type { EditorView } from '@codemirror/view'

import { createCmAnchor } from './quickAsk.anchor'

/**
 * The anchor only touches `view.dom` structurally here (a `closest` walk and
 * an owner document), so a stand-in is enough — this file is about the
 * contract, not about CodeMirror.
 */
function fakeView(): EditorView {
  const dom = {
    closest: () => null,
    ownerDocument: { documentElement: {}, body: {} },
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 }),
  }
  return { dom, scrollDOM: null } as unknown as EditorView
}

describe('createCmAnchor', () => {
  // The anchor narrows DOM nodes with `instanceof HTMLElement`; this suite
  // runs without a DOM, and its stand-in view is never an element.
  beforeAll(() => {
    ;(globalThis as { HTMLElement?: unknown }).HTMLElement = class {}
  })

  // A board pans by transform and fires no scroll event, so the surface that
  // moved the anchor is the only thing that can say it moved.
  it('carries a move subscription through to the overlay', () => {
    const unsubscribe = jest.fn()
    const subscribe = jest.fn(() => unsubscribe)
    const onMove = jest.fn()

    const anchor = createCmAnchor(fakeView(), 0, null, { subscribe })

    expect(anchor.subscribe).toBeDefined()
    expect(anchor.subscribe?.(onMove)).toBe(unsubscribe)
    expect(subscribe).toHaveBeenCalledWith(onMove)
  })

  it('leaves the subscription out when the surface does not move on its own', () => {
    expect(createCmAnchor(fakeView(), 0, null).subscribe).toBeUndefined()
    expect(createCmAnchor(fakeView(), 0, null, {}).subscribe).toBeUndefined()
  })
})
