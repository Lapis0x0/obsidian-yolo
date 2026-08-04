import type { EditorState, EditorUpdateOptions, LexicalEditor } from 'lexical'

// Lexical 0.17.1 treats this tag as a background update: when the editor root
// is not active, reconciliation updates its DOM without taking over the
// document selection. Keep the version-specific tag contained here so a
// future Lexical upgrade can replace it with SKIP_DOM_SELECTION_TAG.
export const LEXICAL_BACKGROUND_UPDATE_TAG = 'collaboration'

function isEditorRootActive(root: HTMLElement | null): boolean {
  return root !== null && root.ownerDocument.activeElement === root
}

function getExternalStateTag(root: HTMLElement | null): string | undefined {
  return isEditorRootActive(root) ? undefined : LEXICAL_BACKGROUND_UPDATE_TAG
}

export function updateLexicalFromExternalState(
  editor: LexicalEditor,
  root: HTMLElement | null,
  update: () => void,
  options?: EditorUpdateOptions,
): void {
  const tag = getExternalStateTag(root)
  editor.update(update, tag ? { ...options, tag } : options)
}

export function setLexicalStateFromExternalState(
  editor: LexicalEditor,
  root: HTMLElement | null,
  state: EditorState,
): void {
  const tag = getExternalStateTag(root)
  editor.setEditorState(state, tag ? { tag } : undefined)
}
