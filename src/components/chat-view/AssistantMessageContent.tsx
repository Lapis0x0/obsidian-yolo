import React, { useCallback, useMemo } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { CitationSource } from '../../core/agent/citationRegistry'
import { ChatAssistantMessage } from '../../types/chat'
import type { MentionableAssistantQuote } from '../../types/mentionable'
import { injectAnnotationMarkers } from '../../utils/chat/inject-annotation-markers'
import {
  ParsedTagContent,
  parseTagContents,
} from '../../utils/chat/parse-tag-content'

import AssistantMessageReasoning from './AssistantMessageReasoning'
import AssistantSelectionQuoteButton from './AssistantSelectionQuoteButton'
import MarkdownCodeComponent from './MarkdownCodeComponent'
import MarkdownReferenceBlock from './MarkdownReferenceBlock'
import { getToolDisplayInfo, getToolLabels } from './ToolMessage'
import TransitioningMarkdown from './TransitioningMarkdown'
import {
  type StreamingContentSource,
  useAssistantStreamedContent,
} from './useAssistantRenderStream'

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
  annotations,
  sources,
  handleApply,
  isApplying,
  activeApplyRequestKey,
  generationState,
  reasoningDurationMs,
  toolCallRequests,
  showToolCallPreview = false,
  messageId,
  conversationId,
  onQuote,
  assistantQuotes = [],
  onDeleteQuote,
  enableSelectionQuote = true,
}: {
  content: ChatAssistantMessage['content']
  annotations?: ChatAssistantMessage['annotations']
  sources?: CitationSource[]
  handleApply: (
    blockToApply: string,
    applyRequestKey: string,
    targetFilePath?: string,
  ) => void
  isApplying: boolean
  activeApplyRequestKey: string | null
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
  reasoningDurationMs?: number
  toolCallRequests?: ChatAssistantMessage['toolCallRequests']
  showToolCallPreview?: boolean
  messageId: string
  conversationId: string
  onQuote: (payload: {
    id?: string
    annotationNumber?: number
    messageId: string
    conversationId: string
    content: string
    comment?: string
    selector?: MentionableAssistantQuote['selector']
  }) => void
  assistantQuotes?: readonly MentionableAssistantQuote[]
  onDeleteQuote?: (id: string) => void
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

  // 生成中的正文不再随会话快照到达：它是一条按 conversationId + messageId
  // 索引的展示流。annotations 会重写正文（注记标记插入），所以它一旦存在就
  // 必须关闭命令式源，退回按快照渲染。
  const { content: streamedContent, contentSource } =
    useAssistantStreamedContent({
      conversationId,
      messageId,
      isStreaming: generationState === 'streaming',
      content,
      allowLiveSource: !annotations,
    })

  const annotatedContent = useMemo(
    () => injectAnnotationMarkers(streamedContent, annotations),
    [streamedContent, annotations],
  )

  return (
    <AssistantTextRenderer
      contentSource={contentSource}
      onApply={onApply}
      isApplying={isApplying}
      activeApplyRequestKey={activeApplyRequestKey}
      generationState={generationState}
      reasoningDurationMs={reasoningDurationMs}
      toolCallRequests={toolCallRequests}
      showToolCallPreview={showToolCallPreview}
      messageId={messageId}
      conversationId={conversationId}
      onQuote={onQuote}
      assistantQuotes={assistantQuotes}
      onDeleteQuote={onDeleteQuote}
      enableSelectionQuote={enableSelectionQuote}
      sources={sources}
    >
      {annotatedContent}
    </AssistantTextRenderer>
  )
}

const AssistantTextRenderer = React.memo(function AssistantTextRenderer({
  contentSource,
  onApply,
  isApplying,
  activeApplyRequestKey,
  generationState,
  reasoningDurationMs,
  toolCallRequests,
  showToolCallPreview,
  messageId,
  conversationId,
  onQuote,
  assistantQuotes,
  onDeleteQuote,
  enableSelectionQuote,
  sources,
  children,
}: {
  contentSource: StreamingContentSource | null
  onApply: (
    blockToApply: string,
    applyRequestKey: string,
    targetFilePath?: string,
  ) => void
  children: string
  isApplying: boolean
  activeApplyRequestKey: string | null
  generationState?: 'streaming' | 'completed' | 'aborted' | 'error'
  reasoningDurationMs?: number
  toolCallRequests?: ChatAssistantMessage['toolCallRequests']
  showToolCallPreview: boolean
  messageId: string
  conversationId: string
  onQuote: (payload: {
    id?: string
    annotationNumber?: number
    messageId: string
    conversationId: string
    content: string
    comment?: string
    selector?: MentionableAssistantQuote['selector']
  }) => void
  assistantQuotes: readonly MentionableAssistantQuote[]
  onDeleteQuote?: (id: string) => void
  enableSelectionQuote: boolean
  sources?: CitationSource[]
}) {
  const { t } = useLanguage()

  const blocks: ParsedTagContent[] = useMemo(
    () =>
      contentSource
        ? // 命令式源只在"正文里没有任何标签"时才存在（见 useAssistantRenderStream），
          // 此时 parseTagContents 的结果恒为单个 string 块。保持与慢路径同样的
          // JSX 形状，标签出现时可以原地切换而不卸载 markdown 播放器。
          [{ type: 'string', content: children }]
        : parseTagContents(children),
    [children, contentSource],
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
      {blocks.map((block, blockIndex) => {
        const blockKey =
          block.type === 'string' || block.type === 'think'
            ? `${block.type}-${blockIndex}`
            : `${block.type}-${block.filename ?? ''}-${block.startLine ?? ''}-${block.endLine ?? ''}-${block.content.slice(0, 64)}`

        return block.type === 'string' ? (
          <div key={blockKey}>
            <TransitioningMarkdown
              content={block.content}
              contentSource={contentSource}
              scale="sm"
              generationState={generationState}
              citationSources={sources}
            />
          </div>
        ) : block.type === 'think' ? (
          <AssistantMessageReasoning
            key={blockKey}
            reasoning={block.content}
            hasAnswerContent={hasAnswerContent}
            generationState={generationState}
            reasoningDurationMs={reasoningDurationMs}
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
        <div className="yolo-toolcall-container yolo-assistant-tool-running-preview">
          <div className="yolo-toolcall">
            <div className="yolo-toolcall-header yolo-assistant-tool-running-preview-header">
              <div className="yolo-toolcall-header-content">
                <span className="yolo-toolcall-header-tool-name">
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
      quotes={assistantQuotes}
      onQuote={onQuote}
      onDeleteQuote={onDeleteQuote}
    >
      {renderedContent}
    </AssistantSelectionQuoteButton>
  )
})
