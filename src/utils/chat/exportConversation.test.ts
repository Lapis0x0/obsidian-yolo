import type { App } from 'obsidian'

import {
  applyDateTokens,
  buildExportFileBaseName,
  conversationToMarkdown,
  getChatExportFolderPath,
  renderFilenameTemplate,
} from './exportConversation'

type UniqueNoteOptions = {
  folder?: string
  format?: string
}

function makeApp(unique?: { enabled: boolean; options?: UniqueNoteOptions }): App {
  if (!unique) return {} as App
  return {
    internalPlugins: {
      getPluginById: (id: string) =>
        id === 'unique-note'
          ? {
              enabled: unique.enabled,
              instance: { options: unique.options ?? {} },
            }
          : null,
    },
  } as unknown as App
}

describe('getChatExportFolderPath', () => {
  it('defaults to {baseDir}/Exports when no chatExport config is provided', () => {
    expect(getChatExportFolderPath(makeApp())).toBe('YOLO/Exports')
    expect(
      getChatExportFolderPath(makeApp(), {
        yolo: { baseDir: 'Config/YOLO' },
      }),
    ).toBe('Config/YOLO/Exports')
  })

  it('honors a custom chatExport.folder over the default', () => {
    expect(
      getChatExportFolderPath(makeApp(), {
        chatExport: { folder: 'Inbox/Chats' },
      }),
    ).toBe('Inbox/Chats')
  })

  it('strips leading/trailing slashes from a custom folder', () => {
    expect(
      getChatExportFolderPath(makeApp(), {
        chatExport: { folder: '/Inbox/Chats/' },
      }),
    ).toBe('Inbox/Chats')
  })

  it('reads unique-note folder when followUniqueNote is on and plugin enabled', () => {
    const app = makeApp({
      enabled: true,
      options: { folder: 'Daily', format: 'YYYY-MM-DD HHmm' },
    })
    expect(
      getChatExportFolderPath(app, {
        chatExport: { followUniqueNote: true, folder: 'Inbox/Chats' },
      }),
    ).toBe('Daily')
  })

  it('falls back to custom folder when followUniqueNote is on but plugin disabled', () => {
    const app = makeApp({ enabled: false })
    expect(
      getChatExportFolderPath(app, {
        chatExport: { followUniqueNote: true, folder: 'Inbox/Chats' },
      }),
    ).toBe('Inbox/Chats')
  })

  it('returns "/" when unique-note folder is empty (vault root)', () => {
    const app = makeApp({
      enabled: true,
      options: { folder: '', format: 'YYYYMMDDHHmmss' },
    })
    expect(
      getChatExportFolderPath(app, {
        chatExport: { followUniqueNote: true },
      }),
    ).toBe('/')
  })
})

describe('applyDateTokens', () => {
  const date = new Date(2026, 4, 21, 17, 14, 30, 7) // 2026-05-21 17:14:30.007

  it('replaces year/month/day/hour/minute/second tokens', () => {
    expect(applyDateTokens('YYYY-MM-DD HH:mm:ss', date)).toBe(
      '2026-05-21 17:14:30',
    )
  })

  it('supports YY 2-digit year and SSS milliseconds', () => {
    expect(applyDateTokens('YY/SSS', date)).toBe('26/007')
  })

  it('leaves non-token characters intact', () => {
    expect(applyDateTokens('YYYY_MM-DD', date)).toBe('2026_05-21')
  })
})

describe('renderFilenameTemplate', () => {
  const date = new Date(2026, 4, 21, 17, 14, 30) // 2026-05-21 17:14:30

  it('renders title and default date/time', () => {
    expect(renderFilenameTemplate('{{title}} - {{date}}', { title: 'Foo', date }))
      .toBe('Foo - 2026-05-21')
    expect(renderFilenameTemplate('{{time}}', { title: 'x', date })).toBe(
      '171430',
    )
  })

  it('honors {{date:FMT}} and {{time:FMT}} arguments', () => {
    expect(
      renderFilenameTemplate('{{date:YYYYMM}}-{{time:HHmm}}', {
        title: 'x',
        date,
      }),
    ).toBe('202605-1714')
  })

  it('supports {{datetime}} and {{timestamp}} shortcuts', () => {
    expect(renderFilenameTemplate('{{datetime}}', { title: 'x', date })).toBe(
      '2026-05-21_171430',
    )
    expect(
      renderFilenameTemplate('{{timestamp}}', { title: 'x', date }),
    ).toBe(String(Math.floor(date.getTime() / 1000)))
  })

  it('falls back to default template on empty input', () => {
    expect(renderFilenameTemplate('', { title: 'Foo', date })).toBe(
      'Foo - 2026-05-21',
    )
  })

  it('drops unknown placeholders to keep filenames clean', () => {
    expect(
      renderFilenameTemplate('{{title}}{{unknown}}', { title: 'Foo', date }),
    ).toBe('Foo')
  })
})

describe('buildExportFileBaseName', () => {
  const date = new Date(2026, 4, 21, 17, 14, 30)

  it('uses the template when no unique-note format is provided', () => {
    expect(
      buildExportFileBaseName('Hello', date, {
        template: '{{title}} - {{date}}',
      }),
    ).toBe('Hello - 2026-05-21')
  })

  it('renders unique-note format alone when appendTitle is false', () => {
    expect(
      buildExportFileBaseName('Hello', date, {
        uniqueNoteFormat: 'YYYYMMDDHHmmss',
        appendTitleWhenFollowing: false,
      }),
    ).toBe('20260521171430')
  })

  it('appends title when appendTitleWhenFollowing is true', () => {
    expect(
      buildExportFileBaseName('Hello', date, {
        uniqueNoteFormat: 'YYYYMMDDHHmmss',
        appendTitleWhenFollowing: true,
      }),
    ).toBe('20260521171430_Hello')
  })

  it('sanitizes illegal filename characters', () => {
    expect(
      buildExportFileBaseName('Foo/Bar:Baz', date, {
        template: '{{title}}',
      }),
    ).toBe('Foo_Bar_Baz')
  })
})

describe('conversationToMarkdown', () => {

  it('renders assistant thinking before the final response content', () => {
    const markdown = conversationToMarkdown(
      {
        schemaVersion: 1,
        id: 'conversation-1',
        title: 'Export test',
        createdAt: 0,
        updatedAt: 0,
        messages: [
          {
            role: 'assistant',
            id: 'assistant-1',
            content: 'final answer',
            reasoning: 'reasoning trace',
          },
        ],
      },
      {
        snapshotEntries: {},
        exportedAtIso: '2026-04-09T00:00:00.000Z',
      },
    )

    expect(markdown.indexOf('> [!note]- Thinking')).toBeGreaterThan(
      markdown.indexOf('## Assistant'),
    )
    expect(markdown.indexOf('reasoning trace')).toBeLessThan(
      markdown.indexOf('final answer'),
    )
  })

  it('renders mentioned vault files as a collapsed callout in user messages', () => {
    const markdown = conversationToMarkdown(
      {
        schemaVersion: 1,
        id: 'conversation-1',
        title: 'Export test',
        createdAt: 0,
        updatedAt: 0,
        messages: [
          {
            role: 'user',
            id: 'user-1',
            content: null,
            promptContent: `## Mentioned Vault Files (outline only)
- \`Folder/Test.md\`
  - L1 # Intro

This section provides only paths and outlines. Use file tools only if you need the full contents or a specific line range.

@Folder/Test.md 看一下`,
            mentionables: [],
          },
        ],
      },
      {
        snapshotEntries: {},
        exportedAtIso: '2026-04-09T00:00:00.000Z',
      },
    )

    expect(markdown).toContain('> [!info]- Mentioned vault files')
    expect(markdown).toContain('> - `Folder/Test.md`')
    expect(markdown).toContain('@Folder/Test.md 看一下')
    expect(markdown).not.toContain('## Mentioned Vault Files (outline only)')
  })

  it('does not include a blank line or title heading after frontmatter', () => {
    const markdown = conversationToMarkdown(
      {
        schemaVersion: 1,
        id: 'conversation-1',
        title: 'Export test',
        createdAt: 0,
        updatedAt: 0,
        messages: [
          {
            role: 'user',
            id: 'user-1',
            content: null,
            promptContent: 'first prompt',
            mentionables: [],
          },
        ],
      },
      {
        snapshotEntries: {},
        exportedAtIso: '2026-04-09T00:00:00.000Z',
      },
    )

    expect(markdown).toContain('conversation_id: conversation-1\n---\n## User')
    expect(markdown).not.toContain('\n---\n\n')
    expect(markdown).not.toContain('# Export test')
  })

  it('inserts compaction summaries after their anchor messages instead of at the top', () => {
    const markdown = conversationToMarkdown(
      {
        schemaVersion: 1,
        id: 'conversation-1',
        title: 'Export test',
        createdAt: 0,
        updatedAt: 0,
        messages: [
          {
            role: 'user',
            id: 'user-1',
            content: null,
            promptContent: 'first prompt',
            mentionables: [],
          },
          {
            role: 'assistant',
            id: 'assistant-1',
            content: 'first answer',
          },
          {
            role: 'user',
            id: 'user-2',
            content: null,
            promptContent: 'second prompt',
            mentionables: [],
          },
        ],
        compaction: {
          anchorMessageId: 'assistant-1',
          summary: 'Earlier history summary',
          compactedAt: 1,
        },
      },
      {
        snapshotEntries: {},
        exportedAtIso: '2026-04-09T00:00:00.000Z',
      },
    )

    const firstAnswerIndex = markdown.indexOf('first answer')
    const summaryIndex = markdown.indexOf('## Context summary')
    const summaryTextIndex = markdown.indexOf('Earlier history summary')
    const secondPromptIndex = markdown.indexOf('second prompt')

    expect(summaryIndex).toBeGreaterThan(
      markdown.indexOf('conversation_id: conversation-1'),
    )
    expect(summaryIndex).toBeGreaterThan(firstAnswerIndex)
    expect(summaryTextIndex).toBeGreaterThan(summaryIndex)
    expect(secondPromptIndex).toBeGreaterThan(summaryTextIndex)
  })
})
