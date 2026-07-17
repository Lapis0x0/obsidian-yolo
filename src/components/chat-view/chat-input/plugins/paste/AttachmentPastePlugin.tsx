import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { COMMAND_PRIORITY_HIGH, PASTE_COMMAND } from 'lexical'
import { useEffect } from 'react'

import { getFilesFromClipboardData } from '../../utils/file-upload'

export default function AttachmentPastePlugin({
  onPasteFiles,
}: {
  onPasteFiles?: (files: File[]) => void
}) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!onPasteFiles) return false
        if (!(event instanceof ClipboardEvent)) return false
        const clipboardData = event.clipboardData
        if (!clipboardData) return false

        const files = getFilesFromClipboardData(clipboardData)
        if (files.length === 0) return false

        event.preventDefault()
        onPasteFiles(files)
        return true
      },
      COMMAND_PRIORITY_HIGH,
    )
  }, [editor, onPasteFiles])

  return null
}
