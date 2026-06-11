import { $insertDataTransferForPlainText } from '@lexical/clipboard'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  PASTE_COMMAND,
} from 'lexical'
import { useEffect } from 'react'

export default function PlainTextPastePlugin() {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        if (!(event instanceof ClipboardEvent)) return false
        const clipboardData = event.clipboardData
        if (!clipboardData) return false

        // 内部 Lexical 复制：让默认处理器走 application/x-lexical-editor 通道，保留 mention/skill 节点
        if (clipboardData.types.includes('application/x-lexical-editor')) {
          return false
        }
        // 边界：x-lexical-editor 被剥掉但 HTML 仍带 mention/skill 自定义属性，交给默认处理器走 HTML fallback
        const html = clipboardData.getData('text/html')
        if (
          html &&
          (html.includes('data-lexical-mention') ||
            html.includes('data-lexical-skill'))
        ) {
          return false
        }

        const selection = $getSelection()
        if (!$isRangeSelection(selection)) return false

        event.preventDefault()
        $insertDataTransferForPlainText(clipboardData, selection)
        return true
      },
      COMMAND_PRIORITY_LOW,
    )
  }, [editor])

  return null
}
