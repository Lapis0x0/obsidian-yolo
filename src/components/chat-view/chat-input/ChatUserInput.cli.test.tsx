import { renderToStaticMarkup } from 'react-dom/server'

jest.mock('../../../contexts/app-context', () => ({
  useApp: () => ({}),
}))

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) =>
      key === 'chat.placeholderMentionReferences'
        ? 'add references'
        : (fallback ?? key),
  }),
}))

jest.mock('../../../contexts/settings-context', () => ({
  useSettings: () => ({
    settings: {
      chatOptions: { mentionDisplayMode: 'inline' },
      chatModels: [{ id: 'model-1', name: 'Model 1', enable: true }],
      assistants: [
        {
          id: 'assistant-1',
          name: 'Assistant',
          systemPrompt: '',
          skillPreferences: {},
        },
      ],
      skills: { disabledSkillIds: [] },
    },
    setSettings: jest.fn(),
  }),
}))

jest.mock('../../../hooks/useLiteSkillEntries', () => ({
  useLiteSkillEntries: () => [
    {
      name: 'review',
      description: 'Review changes',
      path: 'review',
      mode: 'always',
    },
  ],
}))

jest.mock('../../../core/skills/skillPolicy', () => ({
  isSkillEnabledForAssistant: () => true,
}))

jest.mock('../hooks/useSnippetEntries', () => ({
  useSnippetEntries: () => [],
}))

jest.mock('./MessageInputCore', () => ({
  __esModule: true,
  default: jest.requireActual<typeof import('react')>('react').forwardRef(
    (
      props: {
        models: unknown[]
        enableSkills: boolean
        enableAttachments: boolean
        skipImageModelCapabilityCheck: boolean
        mentionables: unknown[]
        selectedSkills: unknown[]
      },
      _ref,
    ) => (
      <div
        data-testid="message-input-core"
        data-model-count={props.models.length}
        data-skills-enabled={String(props.enableSkills)}
        data-attachments-enabled={String(props.enableAttachments)}
        data-skip-image-model-check={String(
          props.skipImageModelCapabilityCheck,
        )}
        data-mentionable-count={props.mentionables.length}
        data-selected-skill-count={props.selectedSkills.length}
      />
    ),
  ),
}))

jest.mock('./ModelSelect', () => ({
  ModelSelect: () => <span data-control="model" />,
}))

jest.mock('./ReasoningSelect', () => ({
  ReasoningSelect: () => <span data-control="reasoning" />,
  supportsReasoning: () => true,
}))

jest.mock('./ChatModeSelect', () => ({
  ...jest.requireActual('./ChatModeSelect'),
  ChatModeSelect: () => <span data-control="chat-mode" />,
}))

jest.mock('./FileUploadButton', () => ({
  FileUploadButton: () => <button data-control="attachment" />,
}))

jest.mock('./SubmitButton', () => ({
  SubmitButton: () => <button data-control="submit" />,
}))

jest.mock('./ChatSkillBadge', () => ({
  __esModule: true,
  default: () => <span data-control="skill-badge" />,
}))

jest.mock('./ChatQuickAccess', () => ({
  ChatQuickAccess: () => <div />,
}))

import type { ChatUserMessage } from '../../../types/chat'

import ChatUserInput from './ChatUserInput'

const baseProps = {
  initialSerializedEditorState: null,
  onChange: jest.fn(),
  onSubmit: jest.fn(),
  onFocus: jest.fn(),
  setMentionables: jest.fn(),
  setSelectedSkills: jest.fn(),
  currentAssistantId: 'assistant-1',
  modelId: 'model-1',
  showModelControl: false,
  allowModelMentions: false,
  showReasoningSelect: false,
  skipImageModelCapabilityCheck: true,
}

describe('ChatUserInput CLI capabilities', () => {
  it('hides YOLO controls and model mentions while retaining references, skills, and attachments', () => {
    const mentionable = {
      type: 'file',
      file: { path: 'spec.md' },
    } as ChatUserMessage['mentionables'][number]
    const html = renderToStaticMarkup(
      <ChatUserInput
        {...baseProps}
        mentionables={[mentionable]}
        selectedSkills={[
          { name: 'review', description: 'Review changes', path: 'review' },
        ]}
      />,
    )

    expect(html).not.toContain('data-control="model"')
    expect(html).not.toContain('data-control="reasoning"')
    expect(html).not.toContain('data-control="chat-mode"')
    expect(html).toContain('data-model-count="0"')
    expect(html).toContain('data-skills-enabled="true"')
    expect(html).toContain('data-attachments-enabled="true"')
    expect(html).toContain('data-skip-image-model-check="true"')
    expect(html).toContain('data-mentionable-count="1"')
    expect(html).toContain('data-selected-skill-count="1"')
    expect(html).toContain('data-control="attachment"')
  })

  it('uses the references-only placeholder when model mentions are disabled', () => {
    const html = renderToStaticMarkup(
      <ChatUserInput {...baseProps} mentionables={[]} selectedSkills={[]} />,
    )

    expect(html).toContain('add references')
    expect(html).not.toContain('add references or models')
  })
})
