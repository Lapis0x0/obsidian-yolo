import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createRangeSelection,
  $createTextNode,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  COMMAND_PRIORITY_HIGH,
  DROP_COMMAND,
} from 'lexical'
import { useEffect } from 'react'

import { useApp } from '../../../../../contexts/app-context'
import {
  getMentionableName,
  serializeMentionable,
} from '../../../../../utils/chat/mentionable'
import { $createMentionNode } from '../mention/MentionNode'

import { resolveDrop } from './resolveDrop'

/**
 * The chat input's only drop handler.
 *
 * Registered above Lexical's own rich-text DROP_COMMAND handler, which would
 * otherwise turn any dropped file into a DRAG_DROP_PASTE. Claiming the drop
 * here keeps a single answer to "what was dropped" — see resolveDrop. Files
 * that belong to the attachment flow are forwarded to `onDropFiles` rather
 * than routed through a second path.
 */
export default function ObsidianFileDropPlugin({
  onDropFiles,
}: {
  onDropFiles?: (files: File[]) => void
}): null {
  const [editor] = useLexicalComposerContext()
  const app = useApp()

  useEffect(() => {
    return editor.registerCommand<DragEvent>(
      DROP_COMMAND,
      (event) => {
        const dataTransfer = event.dataTransfer
        if (!dataTransfer) {
          return false
        }

        const { mentionables, files } = resolveDrop(app, dataTransfer)
        const droppableFiles = onDropFiles ? files : []
        if (mentionables.length === 0 && droppableFiles.length === 0) {
          return false
        }

        event.preventDefault()
        event.stopPropagation()

        if (droppableFiles.length > 0) {
          onDropFiles?.(droppableFiles)
        }

        if (mentionables.length === 0) {
          return true
        }

        // Capture drop coordinates before the update so we can position the
        // cursor at the actual drop point rather than the old caret position.
        const dropX = event.clientX
        const dropY = event.clientY

        editor.update(() => {
          let selectionPositioned = false

          // Use the document where the drop happened so coordinates resolve
          // correctly when the chat panel is in a pop-out window.
          const dropDoc = event.view?.document ?? document
          const domRange =
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- caretRangeFromPoint is still the most reliable API in Chromium/Obsidian
            typeof dropDoc.caretRangeFromPoint === 'function'
              ? // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
                dropDoc.caretRangeFromPoint(dropX, dropY)
              : null

          if (domRange !== null) {
            try {
              const domNode = domRange.startContainer
              const domOffset = domRange.startOffset
              const lexicalNode = $getNearestNodeFromDOMNode(domNode)
              if (lexicalNode !== null) {
                const newSel = $createRangeSelection()
                const key = lexicalNode.getKey()
                if ($isTextNode(lexicalNode)) {
                  newSel.anchor.set(key, domOffset, 'text')
                  newSel.focus.set(key, domOffset, 'text')
                } else {
                  newSel.anchor.set(key, 0, 'element')
                  newSel.focus.set(key, 0, 'element')
                }
                $setSelection(newSel)
                selectionPositioned = true
              }
            } catch {
              // fall through to default positioning
            }
          }

          if (!selectionPositioned) {
            const sel = $getSelection()
            if (!$isRangeSelection(sel)) {
              $getRoot().selectEnd()
            }
          }

          const activeSelection = $getSelection()
          if (!$isRangeSelection(activeSelection)) {
            return
          }

          const nodesToInsert = []
          for (const mentionable of mentionables) {
            nodesToInsert.push(
              $createMentionNode(
                getMentionableName(mentionable),
                serializeMentionable(mentionable),
              ),
            )
            nodesToInsert.push($createTextNode(' '))
          }

          activeSelection.insertNodes(nodesToInsert)
        })

        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
  }, [app, editor, onDropFiles])

  return null
}
