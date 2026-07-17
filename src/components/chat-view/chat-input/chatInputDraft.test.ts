import type { SerializedEditorState } from 'lexical'

import type { ChatUserMessage } from '../../../types/chat'

import {
  ChatInputDraftHolder,
  isChatInputEmpty,
  resolveChatInputEditorSeed,
} from './chatInputDraft'

function createContent(text: string): SerializedEditorState {
  return {
    root: {
      children: [
        {
          children: [
            {
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text,
              type: 'text',
              version: 1,
            },
          ],
          direction: null,
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  } as unknown as SerializedEditorState
}

function createMessage(content: SerializedEditorState): ChatUserMessage {
  return {
    id: 'input',
    role: 'user',
    content,
    promptContent: null,
    mentionables: [],
  }
}

describe('ChatInputDraftHolder', () => {
  it('keeps the latest editor content through a metadata update', () => {
    const initialContent = createContent('initial')
    const latestContent = createContent('latest')
    const holder = new ChatInputDraftHolder(createMessage(initialContent))

    holder.updateContent(latestContent)
    holder.update((message) => ({ ...message, selectedSkills: [] }))

    expect(holder.get().content).toBe(latestContent)
  })

  it('increments replacement version for explicit replacements, including the same id', () => {
    const holder = new ChatInputDraftHolder(createMessage(createContent('one')))
    const replacement = createMessage(createContent('two'))

    holder.replace(replacement)
    holder.replace({ ...replacement, content: createContent('three') })

    expect(holder.getReplacementVersion()).toBe(2)
    expect(holder.get().id).toBe('input')
  })
})

describe('isChatInputEmpty', () => {
  it('only changes emptiness when text, mentionables, or skills cross empty state', () => {
    expect(isChatInputEmpty('   ', 0, 0)).toBe(true)
    expect(isChatInputEmpty('message', 0, 0)).toBe(false)
    expect(isChatInputEmpty('', 1, 0)).toBe(false)
    expect(isChatInputEmpty('', 0, 1)).toBe(false)
  })
})

describe('resolveChatInputEditorSeed', () => {
  it('keeps the seed and does not read changing draft content without replacement', () => {
    const initialContent = createContent('initial')
    const latestContent = createContent('latest')
    const getContent = jest
      .fn<SerializedEditorState | null, []>()
      .mockReturnValueOnce(initialContent)
      .mockReturnValue(latestContent)

    const initialSeed = resolveChatInputEditorSeed(null, 0, getContent)
    const stableSeed = resolveChatInputEditorSeed(initialSeed, 0, getContent)

    expect(stableSeed).toBe(initialSeed)
    expect(stableSeed.content).toBe(initialContent)
    expect(getContent).toHaveBeenCalledTimes(1)
  })

  it('reads the latest content when the replacement version changes', () => {
    const initialSeed = resolveChatInputEditorSeed(null, 0, () =>
      createContent('initial'),
    )
    const replacementContent = createContent('replacement')

    const replacementSeed = resolveChatInputEditorSeed(
      initialSeed,
      1,
      () => replacementContent,
    )

    expect(replacementSeed).not.toBe(initialSeed)
    expect(replacementSeed.content).toBe(replacementContent)
    expect(replacementSeed.replacementVersion).toBe(1)
  })
})
