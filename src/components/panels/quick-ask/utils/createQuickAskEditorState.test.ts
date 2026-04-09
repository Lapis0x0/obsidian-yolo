import type { TFile } from 'obsidian'

import type { MentionableBlock } from '../../../../types/mentionable'
import { editorStateToPlainText } from '../../../chat-view/chat-input/utils/editor-state-to-plain-text'

import { createQuickAskEditorState } from './createQuickAskEditorState'

describe('createQuickAskEditorState', () => {
  it('keeps mention nodes in the serialized message content', () => {
    const selectionMentionable: MentionableBlock = {
      type: 'block',
      content: '主人能指',
      file: {
        path: 'test.md',
        name: 'test.md',
        basename: 'test',
        extension: 'md',
      } as unknown as TFile,
      startLine: 1,
      endLine: 1,
      source: 'selection',
      contentCount: 4,
    }

    const editorState = createQuickAskEditorState({
      prompt: '解释',
      mentionables: [selectionMentionable],
      mentionableUnitLabel: '字符',
    })

    const paragraph = editorState.root.children[0] as unknown as {
      type: string
      children: Array<Record<string, unknown>>
    }
    expect(paragraph?.type).toBe('paragraph')
    expect(paragraph?.children[0]).toMatchObject({
      type: 'mention',
      mentionName: 'test.md (4 字符)',
    })
    expect(editorStateToPlainText(editorState)).toBe('@test.md (4 字符) 解释')
  })
})
