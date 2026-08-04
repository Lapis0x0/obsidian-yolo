import { TFile, TFolder } from 'obsidian'

import type { Mentionable } from '../../types/mentionable'

import {
  buildCliTurnContent,
  stripCliEnvironmentContext,
  stripCliEnvironmentContextFromText,
} from './turn-input'

describe('buildCliTurnContent', () => {
  it('encodes vault references, selected skills, and time without YOLO context compilation', () => {
    const mentionables: Mentionable[] = [
      {
        type: 'file',
        file: Object.assign(new TFile(), { path: 'Notes/a.md' }),
      },
      {
        type: 'folder',
        folder: Object.assign(new TFolder(), { path: 'Projects' }),
      },
      {
        type: 'block',
        file: Object.assign(new TFile(), { path: 'Notes/b.md' }),
        startLine: 4,
        endLine: 6,
        content: 'selected text',
      },
      {
        type: 'web-selection',
        title: 'Reference',
        url: 'https://example.com',
        content: 'web text',
      },
    ]

    const content = buildCliTurnContent({
      runtimeId: 'codex',
      text: 'Please review these.',
      mentionables,
      selectedSkills: [
        { name: 'review', description: 'Review code', path: 'skills/review' },
      ],
      timeContext: '2026-07-30 23:00 (UTC+8)',
    })

    expect(content).toEqual(expect.any(String))
    expect(content).toContain('<current_time>2026-07-30 23:00 (UTC+8)')
    expect(content).not.toContain('<selected_skills>')
    expect(content).toContain('Notes/a.md')
    expect(content).toContain('Projects')
    expect(content).toContain('lines=4-6')
    expect(content).toContain('selected text')
    expect(content).toContain('https://example.com')
    expect(content).toContain('Please review these.')
  })

  it('preserves images and native Claude PDFs as content parts', () => {
    const content = buildCliTurnContent({
      runtimeId: 'claude-code',
      text: 'Inspect attachments.',
      mentionables: [
        {
          type: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          data: 'data:image/png;base64,AAA',
        },
        {
          type: 'pdf',
          name: 'paper.pdf',
          rawData: 'BBB',
          pageCount: 3,
        },
      ],
    })

    expect(content).toEqual([
      { type: 'text', text: 'Inspect attachments.' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAA' },
      },
      {
        type: 'document',
        mediaType: 'application/pdf',
        name: 'paper.pdf',
        data: 'BBB',
        pageCount: 3,
      },
    ])
  })

  it('keeps each assistant quote paired with its optional comment', () => {
    const content = buildCliTurnContent({
      runtimeId: 'codex',
      text: '',
      mentionables: [
        {
          type: 'assistant-quote',
          id: 'annotation-1',
          annotationNumber: 2,
          conversationId: 'conversation-1',
          messageId: 'assistant-1',
          content: 'First quoted passage',
          comment: 'Change this conclusion.',
        },
        {
          type: 'assistant-quote',
          id: 'annotation-2',
          annotationNumber: 4,
          conversationId: 'conversation-1',
          messageId: 'assistant-1',
          content: 'Second quoted passage',
          comment: '',
        },
      ],
    })

    expect(content).toEqual(expect.any(String))
    expect(content).toContain('<quote>\nFirst quoted passage\n</quote>')
    expect(content).toContain('<annotation_number>2</annotation_number>')
    expect(content).toContain('<annotation_number>4</annotation_number>')
    expect(content).toContain('<comment>\nChange this conclusion.\n</comment>')
    expect(content).toContain('<quote>\nSecond quoted passage\n</quote>')
  })

  it('places time and focus context together before the user-authored text', () => {
    const content = buildCliTurnContent({
      runtimeId: 'codex',
      text: 'Continue from here.',
      mentionables: [],
      timeContext: '2026-08-03 10:15 (Monday)',
      environmentContext: [
        {
          type: 'text',
          text: '# Current Context\nFile: Notes/plan.md\nCursor: line 42',
        },
      ],
    })

    expect(content).toBe(
      '<yolo_environment_context>\n' +
        '<current_time>2026-08-03 10:15 (Monday)</current_time>\n\n' +
        '# Current Context\nFile: Notes/plan.md\nCursor: line 42\n' +
        '</yolo_environment_context>\n\n' +
        'Continue from here.',
    )
  })

  it('strips only a leading, complete YOLO environment block', () => {
    expect(
      stripCliEnvironmentContextFromText(
        '<yolo_environment_context>\n<context>hidden</context>\n' +
          '</yolo_environment_context>\n\nVisible message',
      ),
    ).toBe('Visible message')
    expect(
      stripCliEnvironmentContextFromText(
        'Keep <yolo_environment_context>literal user text</yolo_environment_context>',
      ),
    ).toBe(
      'Keep <yolo_environment_context>literal user text</yolo_environment_context>',
    )
  })

  it('keeps an auto-attached focus image inside the environment block before user text', () => {
    const content = buildCliTurnContent({
      runtimeId: 'codex',
      text: 'What am I viewing?',
      mentionables: [],
      timeContext: '2026-08-03 17:45 (Monday)',
      environmentContext: [
        { type: 'text', text: 'The user is viewing this image.' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,AAA' },
        },
      ],
    })
    expect(content).toEqual([
      {
        type: 'text',
        text:
          '<yolo_environment_context>\n' +
          '<current_time>2026-08-03 17:45 (Monday)</current_time>\n\n' +
          'The user is viewing this image.',
      },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAA' },
      },
      { type: 'text', text: '</yolo_environment_context>' },
      { type: 'text', text: 'What am I viewing?' },
    ])
    expect(stripCliEnvironmentContext(content)).toEqual([
      { type: 'text', text: 'What am I viewing?' },
    ])
  })

  it('uses extracted PDF text for Codex and rejects an unreadable PDF', () => {
    expect(
      buildCliTurnContent({
        runtimeId: 'codex',
        text: '',
        mentionables: [
          { type: 'pdf', name: 'paper.pdf', rawData: 'BBB', data: 'pages' },
        ],
      }),
    ).toContain('pages')

    expect(() =>
      buildCliTurnContent({
        runtimeId: 'codex',
        text: 'read it',
        mentionables: [{ type: 'pdf', name: 'paper.pdf', rawData: 'BBB' }],
      }),
    ).toThrow('does not support PDF attachments without extracted text')
  })

  it('encodes text and office attachments and rejects model mentions', () => {
    const content = buildCliTurnContent({
      runtimeId: 'codex',
      text: 'Summarize.',
      mentionables: [
        {
          type: 'text-attachment',
          name: 'data.csv',
          kind: 'csv',
          content: 'a,b',
        },
        {
          type: 'office',
          name: 'brief.docx',
          kind: 'docx',
          rawData: 'AAA',
          extractedText: 'brief text',
        },
      ],
    })
    expect(content).toContain('data.csv')
    expect(content).toContain('a,b')
    expect(content).toContain('brief.docx')
    expect(content).toContain('brief text')

    expect(() =>
      buildCliTurnContent({
        runtimeId: 'codex',
        text: 'hello',
        mentionables: [{ type: 'model', modelId: 'm1', name: 'Model' }],
      }),
    ).toThrow('does not support model mentions')
  })

  it('returns plain text when no structured context exists', () => {
    expect(
      buildCliTurnContent({
        runtimeId: 'claude-code',
        text: 'hello',
        mentionables: [],
      }),
    ).toBe('hello')
  })

  it('invokes an explicitly selected Claude skill through slash syntax', () => {
    expect(
      buildCliTurnContent({
        runtimeId: 'claude-code',
        text: 'Review this change.',
        mentionables: [],
        selectedSkills: [
          {
            name: 'review',
            description: 'Review code',
            path: 'claude-code://skills/review',
          },
        ],
      }),
    ).toBe('/review Review this change.')
  })

  it('keeps a Claude skill command first while placing environment context above user text', () => {
    const content = buildCliTurnContent({
      runtimeId: 'claude-code',
      text: 'Review this change.',
      mentionables: [],
      selectedSkills: [
        {
          name: 'review',
          description: 'Review code',
          path: 'claude-code://skills/review',
        },
      ],
      timeContext: '2026-08-03 18:00 (Monday)',
      environmentContext: [
        { type: 'text', text: '# Current Context\nFile: Notes/plan.md' },
      ],
    })

    expect(content).toBe(
      '/review <yolo_environment_context>\n' +
        '<current_time>2026-08-03 18:00 (Monday)</current_time>\n\n' +
        '# Current Context\nFile: Notes/plan.md\n' +
        '</yolo_environment_context>\n\n' +
        'Review this change.',
    )
    expect(stripCliEnvironmentContext(content)).toBe(
      '/review Review this change.',
    )
  })
})
