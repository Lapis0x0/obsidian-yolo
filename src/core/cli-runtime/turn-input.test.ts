import { TFile, TFolder } from 'obsidian'

import type { Mentionable } from '../../types/mentionable'

import { buildCliTurnContent } from './turn-input'

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

  it('appends the captured environment context to the submitted CLI turn', () => {
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

    expect(content).toEqual([
      {
        type: 'text',
        text: '<current_time>2026-08-03 10:15 (Monday)</current_time>\n\nContinue from here.',
      },
      {
        type: 'text',
        text: '# Current Context\nFile: Notes/plan.md\nCursor: line 42',
      },
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
})
