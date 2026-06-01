import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect } from 'react'

const SELECTED_CLASS = 'yolo-mention-selected'
const MENTION_SELECTOR = '.mention, .yolo-skill-mention'

/**
 * Native text selection only highlights the text run inside a mention pill, so
 * the leading type icon (a ::before background) never looks selected. This
 * plugin tags every mention that intersects the current selection so CSS can
 * highlight the whole pill — icon included — as a single unit.
 *
 * Bound via registerRootListener so it follows the editor into pop-out windows
 * (the selection lives on the root element's own document).
 */
export default function MentionSelectionHighlightPlugin(): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    let boundDoc: Document | null = null

    const sync = () => {
      const root = editor.getRootElement()
      if (!root) {
        return
      }
      const selection = root.ownerDocument.getSelection()
      const selected = new Set<Element>()
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const range = selection.getRangeAt(0)
        root.querySelectorAll(MENTION_SELECTOR).forEach((el) => {
          if (range.intersectsNode(el)) {
            selected.add(el)
          }
        })
      }
      root.querySelectorAll(`.${SELECTED_CLASS}`).forEach((el) => {
        if (!selected.has(el)) {
          el.classList.remove(SELECTED_CLASS)
        }
      })
      selected.forEach((el) => el.classList.add(SELECTED_CLASS))
    }

    const unregister = editor.registerRootListener((root) => {
      if (boundDoc) {
        boundDoc.removeEventListener('selectionchange', sync)
        boundDoc = null
      }
      if (root) {
        boundDoc = root.ownerDocument
        boundDoc.addEventListener('selectionchange', sync)
      }
    })

    return () => {
      unregister()
      if (boundDoc) {
        boundDoc.removeEventListener('selectionchange', sync)
      }
      editor
        .getRootElement()
        ?.querySelectorAll(`.${SELECTED_CLASS}`)
        .forEach((el) => el.classList.remove(SELECTED_CLASS))
    }
  }, [editor])

  return null
}
