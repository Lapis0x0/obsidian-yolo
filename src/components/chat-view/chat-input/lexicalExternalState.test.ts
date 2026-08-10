import type { EditorState, LexicalEditor } from 'lexical'

import {
  LEXICAL_BACKGROUND_UPDATE_TAG,
  setLexicalStateFromExternalState,
  updateLexicalFromExternalState,
} from './lexicalExternalState'

function createRoot(active: boolean): HTMLElement {
  const root = {} as HTMLElement
  const ownerDocument = {
    activeElement: active ? root : ({} as HTMLElement),
  } as unknown as Document
  Object.defineProperty(root, 'ownerDocument', { value: ownerDocument })
  return root
}

describe('Lexical external state updates', () => {
  it('marks updates to an inactive editor as background updates', () => {
    const update = jest.fn()
    const editor = { update } as unknown as LexicalEditor
    const callback = jest.fn()

    updateLexicalFromExternalState(editor, createRoot(false), callback, {
      discrete: true,
    })

    expect(update).toHaveBeenCalledWith(callback, {
      discrete: true,
      tag: LEXICAL_BACKGROUND_UPDATE_TAG,
    })
  })

  it('keeps normal selection reconciliation for the active editor', () => {
    const update = jest.fn()
    const editor = { update } as unknown as LexicalEditor
    const callback = jest.fn()

    updateLexicalFromExternalState(editor, createRoot(true), callback)

    expect(update).toHaveBeenCalledWith(callback, undefined)
  })

  it('marks external state replacement on an inactive editor', () => {
    const setEditorState = jest.fn()
    const editor = { setEditorState } as unknown as LexicalEditor
    const state = {} as EditorState

    setLexicalStateFromExternalState(editor, null, state)

    expect(setEditorState).toHaveBeenCalledWith(state, {
      tag: LEXICAL_BACKGROUND_UPDATE_TAG,
    })
  })
})
