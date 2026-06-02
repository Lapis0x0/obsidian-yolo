import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import {
  conversationToMarkdown,
  getChatExportFolderPath,
} from './exportConversation'

describe('conversationToMarkdown', () => {
  it('uses the yolo base directory for exported chat files', () => {
    expect(getChatExportFolderPath()).toBe('YOLO/Exports')
    expect(
      getChatExportFolderPath({
        yolo: {
          baseDir: 'Config/YOLO',
        },
      }),
    ).toBe('Config/YOLO/Exports')
  })

  it('omits assistant thinking by default', () => {
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

    expect(markdown).not.toContain('> [!note]- Thinking')
    expect(markdown).not.toContain('reasoning trace')
    expect(markdown).toContain('final answer')
  })

  it('renders assistant thinking when includeThinking is enabled', () => {
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
        includeThinking: true,
      },
    )

    expect(markdown.indexOf('> [!note]- Thinking')).toBeGreaterThan(
      markdown.indexOf('## Assistant'),
    )
    expect(markdown.indexOf('reasoning trace')).toBeLessThan(
      markdown.indexOf('final answer'),
    )
  })

  it('omits tool calls by default', () => {
    const emptyArgs = createCompleteToolCallArguments({
      value: { path: 'a.md' },
    })
    const markdown = conversationToMarkdown(
      {
        schemaVersion: 1,
        id: 'conversation-1',
        title: 'Export test',
        createdAt: 0,
        updatedAt: 0,
        messages: [
          {
            role: 'tool',
            id: 'tool-1',
            toolCalls: [
              {
                request: {
                  id: 'call-1',
                  name: 'fs_read',
                  arguments: emptyArgs,
                },
                response: {
                  status: ToolCallResponseStatus.Success,
                  data: { type: 'text', text: 'file contents' },
                },
              },
            ],
          },
        ],
      },
      {
        snapshotEntries: {},
        exportedAtIso: '2026-04-09T00:00:00.000Z',
      },
    )

    expect(markdown).not.toContain('> [!example]- Tool: fs_read')
    expect(markdown).not.toContain('file contents')
  })

  it('renders tool calls when includeToolCalls is enabled', () => {
    const emptyArgs = createCompleteToolCallArguments({
      value: { path: 'a.md' },
    })
    const markdown = conversationToMarkdown(
      {
        schemaVersion: 1,
        id: 'conversation-1',
        title: 'Export test',
        createdAt: 0,
        updatedAt: 0,
        messages: [
          {
            role: 'tool',
            id: 'tool-1',
            toolCalls: [
              {
                request: {
                  id: 'call-1',
                  name: 'fs_read',
                  arguments: emptyArgs,
                },
                response: {
                  status: ToolCallResponseStatus.Success,
                  data: { type: 'text', text: 'file contents' },
                },
              },
            ],
          },
        ],
      },
      {
        snapshotEntries: {},
        exportedAtIso: '2026-04-09T00:00:00.000Z',
        includeToolCalls: true,
      },
    )

    expect(markdown).toContain('> [!example]- Tool: fs_read')
    expect(markdown).toContain('file contents')
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
