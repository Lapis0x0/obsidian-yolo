import { SerializedEditorState, SerializedLexicalNode } from 'lexical'

type PlainTextOptions = {
  ignoreMentionableTypes?: string[]
}

export function editorStateToPlainText(
  editorState: SerializedEditorState | null | undefined,
  options?: PlainTextOptions,
): string {
  if (!editorState || typeof editorState !== 'object') return ''
  const root = editorState.root
  if (!root || typeof root !== 'object') return ''
  return lexicalNodeToPlainText(root as SerializedLexicalNode, options)
}

function lexicalNodeToPlainText(
  node: SerializedLexicalNode | null | undefined,
  options?: PlainTextOptions,
): string {
  if (!node || typeof node !== 'object') return ''
  if (
    node.type === 'mention' &&
    Array.isArray(options?.ignoreMentionableTypes) &&
    options.ignoreMentionableTypes.length > 0
  ) {
    const mentionable =
      'mentionable' in node && typeof node.mentionable === 'object'
        ? node.mentionable
        : null
    const mentionableType =
      mentionable &&
      'type' in mentionable &&
      typeof mentionable.type === 'string'
        ? mentionable.type
        : null
    if (
      mentionableType &&
      options.ignoreMentionableTypes.includes(mentionableType)
    ) {
      return ''
    }
  }
  if ('children' in node) {
    // Process children recursively and join their results
    const children = (node as { children?: SerializedLexicalNode[] | null })
      .children
    if (!Array.isArray(children)) return ''
    return children
      .map((child) => lexicalNodeToPlainText(child, options))
      .join('')
  } else if (node.type === 'linebreak') {
    return '\n'
  } else if ('text' in node && typeof node.text === 'string') {
    return node.text
  }
  return ''
}
