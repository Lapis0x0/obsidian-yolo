// Live CM6 editor factory for a card's "click to edit" step
// (docs/plans/08-25-yolo-whiteboard/p1-design.md §3), ported from the S2
// spike's `editor.ts` (`git show
// spike/s2-editor-lifecycle:src/features/whiteboard-spike/editor.ts`) with
// markdown syntax highlighting added (the spike deliberately skipped it —
// "the spike only needs to prove the mount/edit/blur/recycle lifecycle, not
// editor fidelity"; M1 is real product surface, so fidelity matters here).
//
// Bundles its own `@codemirror/*` dependencies (declared in
// modules/whiteboard/package.json) rather than reusing the host's editor —
// modules may only depend on the Host API and their own declared packages
// (Module Boundaries, CLAUDE.md).

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'

export type WhiteboardEditorHandle = Readonly<{
  view: EditorView
  destroy: () => void
}>

/**
 * Mounts a live CM6 editor into `container` with the given initial text.
 * `onBlur` fires once when the editor loses focus, with the current doc
 * text — the caller owns what happens next (write back, exit edit mode,
 * re-render the static preview): this is the *only* place blur is observed,
 * so every commit path (native blur, a keymap-driven `Escape`, or a
 * caller-forced teardown) funnels through the same callback by triggering a
 * real DOM blur rather than duplicating the write-back logic elsewhere (see
 * `src/ui/canvas.ts`'s `finishEdit`).
 *
 * `ownerDocument` must be the Document currently owning `container` (from
 * `YoloModuleFileViewContextV1.getDocument()`) — required for CM6's
 * selection/focus handling to work correctly when the view's leaf lives in
 * an Obsidian popout window, which has its own Document.
 */
export function mountWhiteboardEditor(
  container: HTMLElement,
  ownerDocument: Document,
  initialText: string,
  onBlur: (text: string) => void,
): WhiteboardEditorHandle {
  const state = EditorState.create({
    doc: initialText,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      EditorView.domEventHandlers({
        blur: (_event, view) => {
          onBlur(view.state.doc.toString())
          return false
        },
      }),
    ],
  })

  const view = new EditorView({
    state,
    parent: container,
    root: ownerDocument,
  })
  view.focus()

  return {
    view,
    destroy: () => view.destroy(),
  }
}
