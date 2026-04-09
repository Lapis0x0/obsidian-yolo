import type { SerializedEditorState, SerializedLexicalNode } from 'lexical'
import { ReactNode, memo, useMemo } from 'react'

import { MENTION_NODE_TYPE } from './chat-input/plugins/mention/MentionNode'
import { SKILL_NODE_TYPE } from './chat-input/plugins/mention/SkillNode'

type ReadOnlyUserMessageContentProps = {
  content: SerializedEditorState | null
  fallbackText: string
}

type SerializedMentionLikeNode = SerializedLexicalNode & {
  type: typeof MENTION_NODE_TYPE
  text?: string
}

type SerializedSkillLikeNode = SerializedLexicalNode & {
  type: typeof SKILL_NODE_TYPE
  text?: string
}

const PARAGRAPH_NODE_TYPE = 'paragraph'
const LINE_BREAK_NODE_TYPE = 'linebreak'

function isLexicalNode(value: unknown): value is SerializedLexicalNode {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in (value as Record<string, unknown>)
  )
}

function getChildren(node: SerializedLexicalNode): SerializedLexicalNode[] {
  if (!('children' in node) || !Array.isArray(node.children)) {
    return []
  }
  return node.children.filter(isLexicalNode)
}

function getNodeText(node: SerializedLexicalNode): string {
  if ('text' in node && typeof node.text === 'string') {
    return node.text
  }
  return ''
}

function renderInlineNodes(
  nodes: SerializedLexicalNode[],
  keyPrefix: string,
): ReactNode[] {
  return nodes.flatMap((node, index) => {
    const key = `${keyPrefix}-${index}`

    if (node.type === MENTION_NODE_TYPE) {
      return (
        <span key={key} className="mention">
          {getNodeText(node as SerializedMentionLikeNode)}
        </span>
      )
    }

    if (node.type === SKILL_NODE_TYPE) {
      return (
        <span key={key} className="mention smtcmp-skill-mention">
          {getNodeText(node as SerializedSkillLikeNode)}
        </span>
      )
    }

    if (node.type === LINE_BREAK_NODE_TYPE) {
      return <br key={key} />
    }

    const text = getNodeText(node)
    if (text.length > 0) {
      return <span key={key}>{text}</span>
    }

    const children = getChildren(node)
    if (children.length > 0) {
      return renderInlineNodes(children, key)
    }

    return []
  })
}

function renderEditorStateContent(
  content: SerializedEditorState | null,
  fallbackText: string,
): ReactNode {
  const root = content?.root
  if (!isLexicalNode(root)) {
    return fallbackText
  }

  const topLevelNodes = getChildren(root)
  if (topLevelNodes.length === 0) {
    return fallbackText
  }

  const paragraphs = topLevelNodes.flatMap((node, index) => {
    const key = `paragraph-${index}`

    if (node.type === PARAGRAPH_NODE_TYPE) {
      const children = renderInlineNodes(getChildren(node), key)
      return (
        <div key={key} className="smtcmp-lexical-content-editable-paragraph">
          {children.length > 0 ? children : '\u00a0'}
        </div>
      )
    }

    if (node.type === LINE_BREAK_NODE_TYPE) {
      return (
        <div key={key} className="smtcmp-lexical-content-editable-paragraph">
          <br />
        </div>
      )
    }

    const children = renderInlineNodes([node], key)
    if (children.length === 0) {
      return []
    }

    return (
      <div key={key} className="smtcmp-lexical-content-editable-paragraph">
        {children}
      </div>
    )
  })

  if (paragraphs.length === 0) {
    return fallbackText
  }

  return paragraphs
}

function ReadOnlyUserMessageContent({
  content,
  fallbackText,
}: ReadOnlyUserMessageContentProps) {
  const renderedContent = useMemo(
    () => renderEditorStateContent(content, fallbackText),
    [content, fallbackText],
  )

  return (
    <div className="smtcmp-lexical-content-editable-root">
      {renderedContent}
    </div>
  )
}

export default memo(ReadOnlyUserMessageContent)
