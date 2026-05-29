import type { ContextVoiceInputOptions } from '../../../settings/schema/setting.types'

import {
  type VoiceInputTarget,
  buildVoiceInputMessages,
} from './voicePromptBuilder'

const baseOptions = {
  systemPromptMode: 'default',
  customSystemPrompt: '',
  maxAfterContextChars: 600,
} as unknown as ContextVoiceInputOptions

const baseTarget = (
  overrides: Partial<VoiceInputTarget> = {},
): VoiceInputTarget => ({
  fileTitle: 'Sample Note',
  filePath: 'Fixtures/context-voice-input/sample-note.md',
  before: '\n## Notes\nThis section covers',
  after: '，后续段落还会展开。\n\n\nParent: [[Index]]\n',
  selectionText: '替换选中的短语',
  hasSelection: true,
  ...overrides,
})

const userContent = (
  input: Parameters<typeof buildVoiceInputMessages>[0],
): string => {
  const messages = buildVoiceInputMessages(input)
  const user = messages.find((m) => m.role === 'user')
  if (typeof user?.content !== 'string') {
    throw new Error('expected string user content')
  }
  return user.content
}

describe('voicePromptBuilder · raw-content tag wrapping', () => {
  // Why this matters: the polish model treats whitespace adjacent to the
  // cursor as positional signal. A "\n" right after <cursor_after> reads as
  // "selection ended at end-of-paragraph"; a "\n" right before
  // </cursor_before> reads as "cursor is on a fresh blank line". Both
  // mis-fire the system prompt's "empty text" branch. Pad-newlines around
  // raw document content must NOT be emitted.
  // The builder must echo the raw payload byte-for-byte between the
  // opening and closing tag — no added padding, no trimming. Each tag is
  // tested with a payload whose first AND last characters are non-newline
  // (so an added wrapper "\n" would corrupt the bytes-equal check) plus a
  // payload that legitimately begins / ends with "\n" (so we also catch
  // accidental TRIMMING of real document content).
  const cases: Array<{ tag: string; payload: string; build: () => string }> = [
    {
      tag: 'cursor_before',
      payload: '\n## Notes\nThis section covers',
      build: () =>
        userContent({
          options: baseOptions,
          target: baseTarget({ before: '\n## Notes\nThis section covers' }),
          asrTranscript: 'x',
        }),
    },
    {
      tag: 'cursor_after',
      payload: '，后续段落还会展开。\n',
      build: () =>
        userContent({
          options: baseOptions,
          target: baseTarget({ after: '，后续段落还会展开。\n' }),
          asrTranscript: 'x',
        }),
    },
    {
      tag: 'current_selection',
      payload: '替换选中的短语',
      build: () =>
        userContent({
          options: baseOptions,
          target: baseTarget({
            hasSelection: true,
            selectionText: '替换选中的短语',
          }),
          asrTranscript: 'x',
        }),
    },
    {
      tag: 'previous_model_output',
      payload: '整理后的短语',
      build: () =>
        userContent({
          options: baseOptions,
          target: baseTarget(),
          asrTranscript: 'x',
          previousModelOutput: '整理后的短语',
        }),
    },
    {
      tag: 'current_asr_final',
      payload: '补充这一句说明。',
      build: () =>
        userContent({
          options: baseOptions,
          target: baseTarget(),
          asrTranscript: '补充这一句说明。',
        }),
    },
  ]

  for (const { tag, payload, build } of cases) {
    test(`<${tag}> echoes payload verbatim — no wrapper newlines, no trimming`, () => {
      expect(build()).toContain(`<${tag}>${payload}</${tag}>`)
    })
  }

  test('<cursor_after> payload begins with the literal next character of the document, not a wrapper newline', () => {
    const content = userContent({
      options: baseOptions,
      target: baseTarget(),
      asrTranscript: '补充这一句说明。',
    })
    expect(content).toContain('<cursor_after>，后续段落')
  })

  test('<cursor_before> payload preserves leading content newline that belongs to the document', () => {
    // The fixture document has a real blank line above the heading; that
    // leading "\n" is content and must survive the change.
    const content = userContent({
      options: baseOptions,
      target: baseTarget(),
      asrTranscript: '补充这一句说明。',
    })
    expect(content).toContain(
      '<cursor_before>\n## Notes\nThis section covers</cursor_before>',
    )
  })

  test('target_metadata tight-wraps payload but preserves inter-line newlines between key:value entries', () => {
    const content = userContent({
      options: baseOptions,
      target: baseTarget(),
      asrTranscript: 'x',
    })
    expect(content).toMatch(
      /<target_metadata>file_title: Sample Note\nfile_path: [^\n]+\nhas_selection: true<\/target_metadata>/,
    )
  })

  test('sections are joined by a single newline, not a blank line', () => {
    const content = userContent({
      options: baseOptions,
      target: baseTarget(),
      asrTranscript: 'x',
    })
    // Every adjacent pair of tags must have exactly one "\n" between them.
    // Two consecutive newlines would mean a blank line crept back in.
    expect(content).not.toMatch(/<\/[a-z_]+>\n\n</)
  })

  test('empty / whitespace-only after-cursor still skips the <cursor_after> block', () => {
    const content = userContent({
      options: baseOptions,
      target: baseTarget({ after: '\n\n' }),
      asrTranscript: 'x',
    })
    expect(content).not.toContain('<cursor_after>')
  })

  test('current_selection is omitted when hasSelection is false', () => {
    const content = userContent({
      options: baseOptions,
      target: baseTarget({ hasSelection: false, selectionText: '' }),
      asrTranscript: 'x',
    })
    expect(content).not.toContain('<current_selection>')
  })
})
