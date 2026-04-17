import { Loader2 } from 'lucide-react'
import React, { useCallback, useMemo } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { ChatAssistantMessage } from '../../types/chat'
import {
  ParsedTagContent,
  parseTagContents,
} from '../../utils/chat/parse-tag-content'

import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantSelectionQuoteButton from './AssistantSelectionQuoteButton'
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
  showToolCallPreview = false,
  messageId,
  conversationId,
  onQuote,
  enableSelectionQuote = true,
}: {
  content: ChatAssistantMessage['content']
  handleApply: (
    blockToApply: string,
    applyRequestKey: string,
    targetFilePath?: string,
  ) => void
  isApplying: boolean
  activeApplyRequestKey: string | null
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
  toolCallRequests?: ChatAssistantMessage['toolCallRequests']
  showToolCallPreview?: boolean
  messageId: string
  conversationId: string
  onQuote: (payload: {
    messageId: string
    conversationId: string
    content: string
  }) => void
  enableSelectionQuote?: boolean
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
      showToolCallPreview={showToolCallPreview}
      messageId={messageId}
      conversationId={conversationId}
      onQuote={onQuote}
      enableSelectionQuote={enableSelectionQuote}
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
  showToolCallPreview,
  messageId,
  conversationId,
  onQuote,
  enableSelectionQuote,
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
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
  toolCallRequests?: ChatAssistantMessage['toolCallRequests']
  showToolCallPreview: boolean
  messageId: string
  conversationId: string
  onQuote: (payload: {
    messageId: string
    conversationId: string
    content: string
  }) => void
  enableSelectionQuote: boolean
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

  const toolPreviewText = useMemo(() => {
    if (!showToolCallPreview || !toolCallRequests?.length) {
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
  }, [showToolCallPreview, t, toolCallRequests])

  const renderedContent = (
    <>
      {blocks.map((block) => {
        const MarkdownRenderer =
          generationState === 'streaming' ? StreamingMarkdown : ObsidianMarkdown
        const blockKey =
          block.type === 'string' || block.type === 'think'
            ? `${block.type}-${block.content.slice(0, 64)}`
            : `${block.type}-${block.filename ?? ''}-${block.startLine ?? ''}-${block.endLine ?? ''}-${block.content.slice(0, 64)}`

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
            previewContent={
              block.filename.toLowerCase().endsWith('.pdf')
                ? block.content
                : undefined
            }
          />
        ) : (
          <MarkdownCodeComponent
            key={blockKey}
            onApply={onApply}
            isApplying={isApplying}
            activeApplyRequestKey={activeApplyRequestKey}
            filename={block.filename}
            generationState={generationState}
          >
            {block.content}
          </MarkdownCodeComponent>
        )
      })}
      {toolPreviewText && (
        <div className="smtcmp-toolcall-container smtcmp-assistant-tool-running-preview">
          <div className="smtcmp-toolcall">
            <div className="smtcmp-toolcall-header smtcmp-assistant-tool-running-preview-header">
              <div className="smtcmp-toolcall-header-icon smtcmp-toolcall-header-icon--status-inline">
                <Loader2 className="smtcmp-spinner" size={14} />
              </div>
              <div className="smtcmp-toolcall-header-content">
                <span className="smtcmp-toolcall-header-tool-name">
                  {toolPreviewText}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )

  if (!enableSelectionQuote) {
    return renderedContent
  }

  return (
    <AssistantSelectionQuoteButton
      messageId={messageId}
      conversationId={conversationId}
      disabled={generationState === 'streaming'}
      onQuote={onQuote}
    >
      {renderedContent}
    </AssistantSelectionQuoteButton>
  )
})
