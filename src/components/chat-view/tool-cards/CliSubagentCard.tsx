import { useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  type ChatRuntimeActions,
  type CliSessionRef,
  RUNTIME_CAPABILITIES,
} from '../../../core/cli-runtime'
import type { ChatMessage } from '../../../types/chat'
import type { CliSubagentPresentation } from '../cliSubagentReadModel'

import { SubagentCardView } from './SubagentCardView'

const mergeTranscript = (
  loaded: readonly ChatMessage[],
  live: readonly ChatMessage[],
): ChatMessage[] => {
  const messages = new Map<string, ChatMessage>()
  for (const message of loaded) messages.set(message.id, message)
  for (const message of live) messages.set(message.id, message)
  return [...messages.values()]
}

export function CliSubagentCard({
  presentation,
  actions,
  sessionRef,
}: {
  presentation: CliSubagentPresentation
  actions: ChatRuntimeActions
  sessionRef: CliSessionRef
}) {
  const { t } = useLanguage()
  const [loadedTranscript, setLoadedTranscript] = useState<
    readonly ChatMessage[]
  >([])
  const [isLoading, setIsLoading] = useState(false)
  const [isDetailOpen, setIsDetailOpen] = useState(false)

  useEffect(() => {
    if (!isDetailOpen || !presentation.taskId) return
    let disposed = false
    let stopWatching: (() => void) | null = null
    setIsLoading(true)
    const ref = {
      parentSessionRef: sessionRef,
      toolCallId: presentation.toolCallId,
      subagentId: presentation.taskId,
    }
    const operation =
      RUNTIME_CAPABILITIES[presentation.runtimeId].supportsSubagentWatch &&
      actions.watchSubagent
        ? actions.watchSubagent(ref, (messages) => {
            if (disposed) return
            setLoadedTranscript(messages)
            setIsLoading(false)
          })
        : actions.readSubagent?.(ref).then((messages) => {
            if (!disposed) {
              setLoadedTranscript(messages)
              setIsLoading(false)
            }
            return () => undefined
          })
    if (!operation) {
      setIsLoading(false)
      return
    }
    void operation
      .then((stop) => {
        if (disposed) stop()
        else stopWatching = stop
      })
      .catch(() => {
        if (!disposed) setIsLoading(false)
      })
    return () => {
      disposed = true
      stopWatching?.()
    }
  }, [
    actions,
    isDetailOpen,
    presentation.runtimeId,
    presentation.taskId,
    presentation.toolCallId,
    sessionRef,
  ])

  const transcript = useMemo(
    () => mergeTranscript(loadedTranscript, presentation.transcript),
    [loadedTranscript, presentation.transcript],
  )

  const fallbackSubtitle =
    presentation.status === 'running'
      ? t('chat.subagent.planningNextMoves', 'Planning next moves')
      : presentation.status === 'dispatched'
        ? t('chat.subagent.statusDispatched', 'Dispatched')
        : presentation.status === 'success'
          ? t('chat.subagent.statusCompleted', 'Completed')
          : presentation.status === 'aborted'
            ? t('chat.subagent.statusAborted', 'Aborted')
            : t('chat.subagent.statusFailed', 'Failed')

  return (
    <SubagentCardView
      title={presentation.title || t('chat.subagent.defaultTitle', 'Subagent')}
      subtitle={presentation.subtitle || fallbackSubtitle}
      status={presentation.status}
      modelName={presentation.modelName}
      prompt={presentation.prompt}
      taskId={presentation.taskId}
      transcript={transcript}
      detailStats={presentation.detailStats}
      isTranscriptLoading={isLoading && transcript.length === 0}
      onDetailOpenChange={setIsDetailOpen}
    />
  )
}
