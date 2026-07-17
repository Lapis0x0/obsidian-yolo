import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { DRAG_DROP_PASTE } from '@lexical/rich-text'
import { COMMAND_PRIORITY_LOW } from 'lexical'
import { useEffect } from 'react'

export default function DragDropPaste({
  onDropFiles,
}: {
  onDropFiles?: (files: File[]) => void
}): null {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      DRAG_DROP_PASTE,
      (files) => {
        if (!onDropFiles || files.length === 0) return false
        onDropFiles(files)
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor, onDropFiles])

  return null
}
