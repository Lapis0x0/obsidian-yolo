import type {
  SerializedEditorState,
  SerializedElementNode,
  SerializedTextNode,
} from 'lexical'

import type { Mentionable } from '../../../../types/mentionable'
import {
  getMentionableName,
  serializeMentionable,
} from '../../../../utils/chat/mentionable'
import type { SerializedMentionNode } from '../../../chat-view/chat-input/plugins/mention/MentionNode'

type CreateQuickAskEditorStateOptions = {
  prompt: string
  mentionables: Mentionable[]
  mentionableUnitLabel: string
}

function createTextNode(text: string): SerializedTextNode {
  return {
    detail: 0,
    format: 0,
    mode: 'normal',
    style: '',
    text,
    type: 'text',
    version: 1,
  }
}

function createMentionNode(
  mentionable: Mentionable,
  mentionableUnitLabel: string,
): SerializedMentionNode {
  const mentionName = getMentionableName(mentionable, {
    unitLabel: mentionableUnitLabel,
  })

  return {
    ...createTextNode(`@${mentionName}`),
    type: 'mention',
    mentionName,
    mentionable: serializeMentionable(mentionable),
  }
}

export function createQuickAskEditorState({
  prompt,
  mentionables,
  mentionableUnitLabel,
}: CreateQuickAskEditorStateOptions): SerializedEditorState {
  const children: Array<SerializedTextNode | SerializedMentionNode> = []

  mentionables.forEach((mentionable) => {
    children.push(createMentionNode(mentionable, mentionableUnitLabel))
    children.push(createTextNode(' '))
  })

  if (prompt || children.length === 0) {
    children.push(createTextNode(prompt))
  }

  return {
    root: {
      children: [
        {
          children,
          direction: 'ltr',
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
          textFormat: 0,
          textStyle: '',
        } as SerializedElementNode<SerializedTextNode | SerializedMentionNode>,
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }
}
