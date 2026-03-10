import React, { useCallback, useMemo } from 'react'
import { Loader2 } from 'lucide-react'

import { useLanguage } from '../../contexts/language-context'
import { ChatAssistantMessage } from '../../types/chat'
import {
  ParsedTagContent,
  parseTagContents,
} from '../../utils/chat/parse-tag-content'

import AssistantMessageReasoning from './AssistantMessageReasoning'
import MarkdownCodeComponent from './MarkdownCodeComponent'
import MarkdownReferenceBlock from './MarkdownReferenceBlock'
import { ObsidianMarkdown } from './ObsidianMarkdown'
import StreamingMarkdown from './StreamingMarkdown'
import { getToolDisplayInfo, getToolLabels } from './ToolMessage'

function hasRenderableAssistantContent(blocks: ParsedTagContent[]): boolean {
  return blocks.some((block) => {
    if (block.type === 'think') {
      return false
    }

    return block.content.trim().length > 0
  })
}

export default function AssistantMessageContent({
  content,
  handleApply,
  isApplying,
  activeApplyRequestKey,
  generationState,
  toolCallRequests,
}: {
  content: ChatAssistantMessage['content']
  handleApply: (
    blockToApply: string,
    applyRequestKey: string,
    targetFilePath?: string,
  ) => void
  isApplying: boolean
  activeApplyRequestKey: string | null
  generationState?: 'streaming' | 'completed' | 'aborted'
  toolCallRequests?: ChatAssistantMessage['toolCallRequests']
}) {
  const onApply = useCallback(
    (
      blockToApply: string,
      applyRequestKey: string,
      targetFilePath?: string,
    ) => {
      handleApply(blockToApply, applyRequestKey, targetFilePath)
    },
    [handleApply],
  )

  return (
    <AssistantTextRenderer
      onApply={onApply}
      isApplying={isApplying}
      activeApplyRequestKey={activeApplyRequestKey}
      generationState={generationState}
      toolCallRequests={toolCallRequests}
    >
      {content}
    </AssistantTextRenderer>
  )
}

const AssistantTextRenderer = React.memo(function AssistantTextRenderer({
  onApply,
  isApplying,
  activeApplyRequestKey,
  generationState,
  toolCallRequests,
  children,
}: {
  onApply: (
    blockToApply: string,
    applyRequestKey: string,
    targetFilePath?: string,
  ) => void
  children: string
  isApplying: boolean
  activeApplyRequestKey: string | null
  generationState?: 'streaming' | 'completed' | 'aborted'
  toolCallRequests?: ChatAssistantMessage['toolCallRequests']
}) {
  const { t } = useLanguage()

  const blocks: ParsedTagContent[] = useMemo(
    () => parseTagContents(children),
    [children],
  )
  const hasAnswerContent = useMemo(
    () => hasRenderableAssistantContent(blocks),
    [blocks],
  )

  const runningToolText = useMemo(() => {
    if (generationState !== 'streaming' || !toolCallRequests?.length) {
      return null
    }
    const labels = getToolLabels(t)
    const toolNames = toolCallRequests
      .map((toolCall) => getToolDisplayInfo(toolCall, labels).displayName)
      .filter(
        (name, index, arr) => name.length > 0 && arr.indexOf(name) === index,
      )
    if (toolNames.length === 0) {
      return t('chat.toolCall.status.running', 'Running')
    }
    return `${t('chat.toolCall.status.running', 'Running')}: ${toolNames.join(', ')}`
  }, [generationState, t, toolCallRequests])

  return (
    <>
      {blocks.map((block) => {
        const MarkdownRenderer =
          generationState === 'streaming' ? StreamingMarkdown : ObsidianMarkdown
        const blockKey =
          block.type === 'string' || block.type === 'think'
            ? `${block.type}-${block.content.slice(0, 64)}`
            : `${block.type}-${block.filename ?? ''}-${block.startLine ?? ''}-${block.endLine ?? ''}-${block.language ?? ''}-${block.content.slice(0, 64)}`

        return block.type === 'string' ? (
          <div key={blockKey}>
            <MarkdownRenderer
              content={block.content}
              scale="sm"
              animateIncrementalText={generationState === 'streaming'}
            />
          </div>
        ) : block.type === 'think' ? (
          <AssistantMessageReasoning
            key={blockKey}
            reasoning={block.content}
            hasAnswerContent={hasAnswerContent}
            generationState={generationState}
          />
        ) : block.startLine && block.endLine && block.filename ? (
          <MarkdownReferenceBlock
            key={blockKey}
            filename={block.filename}
            startLine={block.startLine}
            endLine={block.endLine}
          />
        ) : (
          <MarkdownCodeComponent
            key={blockKey}
            onApply={onApply}
            isApplying={isApplying}
            activeApplyRequestKey={activeApplyRequestKey}
            filename={block.filename}
            language={block.language}
            generationState={generationState}
          >
            {block.content}
          </MarkdownCodeComponent>
        )
      })}
      {runningToolText && (
        <div className="smtcmp-toolcall-container smtcmp-assistant-tool-running-preview">
          <div className="smtcmp-toolcall">
            <div className="smtcmp-toolcall-header smtcmp-assistant-tool-running-preview-header">
              <div className="smtcmp-toolcall-header-icon smtcmp-toolcall-header-icon--status-inline">
                <Loader2 className="smtcmp-spinner" size={14} />
              </div>
              <div className="smtcmp-toolcall-header-content">
                <span className="smtcmp-toolcall-header-tool-name">
                  {runningToolText}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
})
