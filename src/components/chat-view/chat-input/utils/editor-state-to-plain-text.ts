import { SerializedEditorState, SerializedLexicalNode } from 'lexical'

export function editorStateToPlainText(
  editorState: SerializedEditorState | null | undefined,
): string {
  if (!editorState || typeof editorState !== 'object') return ''
  const root = editorState.root
  if (!root || typeof root !== 'object') return ''
  return lexicalNodeToPlainText(root as SerializedLexicalNode)
}

function lexicalNodeToPlainText(
  node: SerializedLexicalNode | null | undefined,
): string {
  if (!node || typeof node !== 'object') return ''
  if ('children' in node) {
    // Process children recursively and join their results
    const children = (node as { children?: SerializedLexicalNode[] | null })
      .children
    if (!Array.isArray(children)) return ''
    return children.map(lexicalNodeToPlainText).join('')
  } else if (node.type === 'linebreak') {
    return '\n'
  } else if ('text' in node && typeof node.text === 'string') {
    return node.text
  }
  return ''
}
