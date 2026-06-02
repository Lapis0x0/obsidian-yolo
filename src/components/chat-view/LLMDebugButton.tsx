import { Check, CopyIcon, Info, Save } from 'lucide-react'
import { App, Notice, TFolder, normalizePath } from 'obsidian'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import {
  flushLLMDebugTraceReads,
  getLLMDebugTraces,
} from '../../core/llm/debugCapture'
import { buildLLMDebugMarkdown } from '../../core/llm/debugMarkdown'
import type YoloPlugin from '../../main'
import type { AssistantToolMessageGroup } from '../../types/chat'
import { ReactModal } from '../common/ReactModal'

import {
  getLLMDebugTraceIdsForMessages,
  hasLLMDebugCacheForTraceIds,
  hasLLMDebugMetadataForMessages,
} from './llmDebugTraceSelection'

export {
  getLLMDebugTraceIdsForMessages,
  hasLLMDebugCacheForMessages,
  hasLLMDebugCacheForTraceIds,
  hasLLMDebugMetadataForMessages,
} from './llmDebugTraceSelection'

const DEBUG_FOLDER = 'YOLO/logs'

async function ensureDebugFolder(app: App): Promise<string> {
  const folderPath = normalizePath(DEBUG_FOLDER)
  const parts = folderPath.split('/').filter(Boolean)
  let currentPath = ''

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part
    const existing = app.vault.getAbstractFileByPath(currentPath)
    if (existing instanceof TFolder) {
      continue
    }
    if (existing) {
      throw new Error(`Cannot create debug folder: ${currentPath} is a file`)
    }
    await app.vault.createFolder(currentPath)
  }

  return folderPath
}

function getLocalTimestampForFilename(date = new Date()): string {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  ].join('_')
}

async function getAvailableDebugPath(app: App): Promise<string> {
  const targetFolderPath = await ensureDebugFolder(app)
  const timestamp = new Date()
  const localTimestamp = getLocalTimestampForFilename(timestamp)
  const baseName = `llm-debug-${localTimestamp}`

  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`
    const filename = `${baseName}${suffix}.md`
    const path = normalizePath(`${targetFolderPath}/${filename}`)
    if (!app.vault.getAbstractFileByPath(path)) {
      return path
    }
  }

  return normalizePath(`${targetFolderPath}/${baseName}-${Date.now()}.md`)
}

function LLMDebugModalContent({
  app,
  markdown,
}: {
  app: App
  markdown: string
  onClose: () => void
}) {
  const { t } = useLanguage()
  const [copied, setCopied] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('Failed to copy LLM debug markdown', error)
      new Notice(t('chat.llmDebug.copyFailed', 'Failed to copy debug data'))
    }
  }

  const handleSave = async () => {
    try {
      const path = await getAvailableDebugPath(app)
      const file = await app.vault.create(path, markdown)
      await app.workspace.getLeaf('tab').openFile(file)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
      new Notice(
        t('chat.llmDebug.saved', 'LLM debug data saved to {{path}}').replace(
          '{{path}}',
          path,
        ),
      )
    } catch (error) {
      console.error('Failed to save LLM debug markdown', error)
      new Notice(t('chat.llmDebug.saveFailed', 'Failed to save debug data'))
    }
  }

  return (
    <div className="yolo-llm-debug-modal">
      <div className="yolo-llm-debug-modal-toolbar">
        <button
          type="button"
          className="clickable-icon yolo-llm-debug-modal-button"
          onClick={() => void handleCopy()}
        >
          {copied ? <Check size={14} /> : <CopyIcon size={14} />}
          <span>
            {copied
              ? t('chat.llmDebug.copied', 'Copied')
              : t('chat.llmDebug.copy', 'Copy')}
          </span>
        </button>
        <button
          type="button"
          className="clickable-icon yolo-llm-debug-modal-button"
          onClick={() => void handleSave()}
        >
          {saved ? <Check size={14} /> : <Save size={14} />}
          <span>
            {saved
              ? t('chat.llmDebug.savedShort', 'Saved')
              : t('chat.llmDebug.save', 'Save')}
          </span>
        </button>
      </div>
      <textarea
        className="yolo-llm-debug-modal-markdown"
        value={markdown}
        readOnly
        spellCheck={false}
      />
    </div>
  )
}

async function openLLMDebugModal({
  app,
  plugin,
  messages,
  traceIds,
  title,
}: {
  app: App
  plugin: YoloPlugin
  messages: AssistantToolMessageGroup
  traceIds?: string[]
  title: string
}): Promise<boolean> {
  const initialTraceIds = traceIds ?? getLLMDebugTraceIdsForMessages(messages)
  if (getLLMDebugTraces(initialTraceIds).length === 0) {
    return false
  }

  await flushLLMDebugTraceReads(initialTraceIds)

  const traces = getLLMDebugTraces(initialTraceIds)
  if (traces.length === 0) {
    return false
  }

  const markdown = buildLLMDebugMarkdown(traces)
  new ReactModal({
    app,
    Component: LLMDebugModalContent,
    props: {
      app,
      markdown,
    },
    options: { title },
    plugin,
  }).open()
  return true
}

export function LLMDebugIconButton({
  messages,
  traceIds,
  className = 'clickable-icon',
  tabIndex,
  onOpen,
  children,
}: {
  messages: AssistantToolMessageGroup
  traceIds?: string[]
  className?: string
  tabIndex?: number
  onOpen?: () => void
  children?: ReactNode
}) {
  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const resolvedTraceIds = useMemo(
    () => traceIds ?? getLLMDebugTraceIdsForMessages(messages),
    [messages, traceIds],
  )
  const hasDebugCache = useMemo(
    () => hasLLMDebugCacheForTraceIds(resolvedTraceIds),
    [resolvedTraceIds],
  )
  // Even when the cache is empty, the assistant message metadata still carries
  // an `llmDebugTraceId` from when the request ran. Surface a disabled button
  // in that state so users understand the data existed but was cleared on
  // restart, instead of the button silently vanishing.
  const hadDebugTrace = useMemo(
    () => hasLLMDebugMetadataForMessages(messages),
    [messages],
  )

  if (!hasDebugCache && !hadDebugTrace) {
    return null
  }

  if (!hasDebugCache) {
    const expiredLabel = t(
      'chat.llmDebug.expired',
      'Debug data was cleared on restart (current session only)',
    )
    // Intentionally omit the `title` attribute here: Obsidian renders its own
    // tooltip from `aria-label`, and adding `title` causes the native browser
    // tooltip to stack on top of it (more visible on disabled buttons).
    return (
      <button
        type="button"
        className={className}
        aria-label={expiredLabel}
        tabIndex={tabIndex}
        disabled
      >
        {children ?? <Info size={12} />}
      </button>
    )
  }

  const label = t('chat.llmDebug.open', 'Open LLM debug data')

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      tabIndex={tabIndex}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void openLLMDebugModal({
          app,
          plugin,
          messages,
          traceIds: resolvedTraceIds,
          title: t('chat.llmDebug.title', 'LLM Debug Data'),
        })
          .then((opened) => {
            if (opened) {
              onOpen?.()
            }
          })
          .catch((error) => {
            console.error('Failed to open LLM debug data', error)
            new Notice(
              t('chat.llmDebug.openFailed', 'Failed to open debug data'),
            )
          })
      }}
    >
      {children ?? <Info size={12} />}
    </button>
  )
}
