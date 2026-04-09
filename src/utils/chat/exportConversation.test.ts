import { conversationToMarkdown } from './exportConversation'

describe('conversationToMarkdown', () => {
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

    expect(summaryIndex).toBeGreaterThan(markdown.indexOf('conversation_id: conversation-1'))
    expect(summaryIndex).toBeGreaterThan(firstAnswerIndex)
    expect(summaryTextIndex).toBeGreaterThan(summaryIndex)
    expect(secondPromptIndex).toBeGreaterThan(summaryTextIndex)
  })
})
