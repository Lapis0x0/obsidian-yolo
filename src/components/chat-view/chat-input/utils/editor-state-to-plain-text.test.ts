import {
  SerializedEditorState,
  SerializedElementNode,
  SerializedTextNode,
} from 'lexical'

import { editorStateToPlainText } from './editor-state-to-plain-text'

describe('editorStateToPlainText', () => {
  it('should convert editor state to plain text', () => {
    const editorState: SerializedEditorState = {
      root: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text: 'Hello, world!',
                type: 'text',
                version: 1,
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
            textFormat: 0,
            textStyle: '',
          } as unknown as SerializedElementNode<SerializedTextNode>,
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    }
    const plainText = editorStateToPlainText(editorState)
    expect(plainText).toBe('Hello, world!')
  })

  it('uses full mentionName instead of truncated display text for URL mentions', () => {
    const fullUrl =
      'https://www.anthropic.com/engineering/some-long-article-path'
    const editorState: SerializedEditorState = {
      root: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'token',
                style: '',
                text: 'https://www.anthropic.com/engin…',
                type: 'mention',
                version: 1,
                mentionName: fullUrl,
                mentionable: { type: 'url', url: fullUrl },
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
            textFormat: 0,
            textStyle: '',
          } as unknown as SerializedElementNode<SerializedTextNode>,
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    }

    expect(editorStateToPlainText(editorState)).toBe(fullUrl)
  })
})
