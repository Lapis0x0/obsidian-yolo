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
import { TFile } from 'obsidian'
import { useEffect } from 'react'

import { useApp } from '../../../../../contexts/app-context'
import { Mentionable } from '../../../../../types/mentionable'
import {
  getMentionableName,
  serializeMentionable,
} from '../../../../../utils/chat/mentionable'
import { $createMentionNode } from '../mention/MentionNode'

const OBSIDIAN_OPEN_PREFIX = 'obsidian://open?'

type ParsedObsidianLink = {
  vault: string | null
  file: string
}

function parseObsidianOpenUrl(raw: string): ParsedObsidianLink | null {
  const trimmed = raw.trim()
  if (!trimmed.startsWith(OBSIDIAN_OPEN_PREFIX)) {
    return null
  }
  try {
    const url = new URL(trimmed)
    const file = url.searchParams.get('file')
    if (!file) {
      return null
    }
    return {
      vault: url.searchParams.get('vault'),
      file,
    }
  } catch {
    return null
  }
}

function extractCandidateUrls(dataTransfer: DataTransfer): string[] {
  const uriList = dataTransfer.getData('text/uri-list')
  if (uriList) {
    const lines = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    if (lines.length > 0) {
      return lines
    }
  }

  const plain = dataTransfer.getData('text/plain')
  if (plain) {
    return plain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  return []
}

export default function ObsidianFileDropPlugin(): null {
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

        // If actual files are present, defer to the existing image DragDropPaste flow.
        if (dataTransfer.files && dataTransfer.files.length > 0) {
          return false
        }

        const candidates = extractCandidateUrls(dataTransfer)
        if (candidates.length === 0) {
          return false
        }

        const currentVaultName = app.vault.getName()
        const resolvedFiles: TFile[] = []
        const seenPaths = new Set<string>()

        for (const candidate of candidates) {
          const parsed = parseObsidianOpenUrl(candidate)
          if (!parsed) {
            continue
          }
          if (parsed.vault && parsed.vault !== currentVaultName) {
            continue
          }

          const linkpath = parsed.file
          let file: TFile | null =
            app.metadataCache.getFirstLinkpathDest(linkpath, '') ?? null

          if (!file) {
            const direct = app.vault.getAbstractFileByPath(linkpath)
            if (direct instanceof TFile) {
              file = direct
            }
          }
          if (!file) {
            const withMd = app.vault.getAbstractFileByPath(`${linkpath}.md`)
            if (withMd instanceof TFile) {
              file = withMd
            }
          }

          if (file && !seenPaths.has(file.path)) {
            seenPaths.add(file.path)
            resolvedFiles.push(file)
          }
        }

        if (resolvedFiles.length === 0) {
          return false
        }

        event.preventDefault()
        event.stopPropagation()

        // Capture drop coordinates before the update so we can position the
        // cursor at the actual drop point rather than the old caret position.
        const dropX = event.clientX
        const dropY = event.clientY

        editor.update(() => {
          let selectionPositioned = false

          const domRange =
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- caretRangeFromPoint is still the most reliable API in Chromium/Obsidian
            typeof document.caretRangeFromPoint === 'function'
              ? // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
                document.caretRangeFromPoint(dropX, dropY)
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
          for (const file of resolvedFiles) {
            const mentionable: Mentionable = { type: 'file', file }
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
  }, [app, editor])

  return null
}
