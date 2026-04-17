import { TFile, TFolder } from 'obsidian'

jest.mock('../../database/json/chat/promptSnapshotStore', () => ({
  readPromptSnapshotEntries: jest.fn(async () => ({})),
}))

jest.mock('../../core/memory/memoryManager', () => ({
  getMemoryPromptContext: jest.fn(async () => ''),
}))

import type { SmartComposerSettings } from '../../settings/schema/setting.types'
import type { ChatUserMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { createCompleteToolCallArguments } from '../../types/tool-call.types'

import {
  RequestContextBuilder,
  extractMarkdownAtxHeadings,
} from './requestContextBuilder'

function createMockFile(path: string): InstanceType<typeof TFile> {
  const extension = path.split('.').pop() ?? ''
  return Object.assign(new TFile(), {
    path,
    extension,
  })
}

function createMockFolder(
  path: string,
  children: Array<InstanceType<typeof TFile> | InstanceType<typeof TFolder>>,
): InstanceType<typeof TFolder> {
  return Object.assign(new TFolder(), {
    path,
    children,
  })
}

function createUserMessage(
  mentionables: ChatUserMessage['mentionables'],
): ChatUserMessage {
  return {
    role: 'user',
    id: 'message-1',
    content: null,
    promptContent: null,
    mentionables,
  }
}

function getTextContent(
  promptContent: ChatUserMessage['promptContent'],
): string {
  if (!promptContent) {
    throw new Error('Expected prompt content to be present')
  }

  if (typeof promptContent === 'string') {
    return promptContent
  }

  const textPart = promptContent.find((part) => part.type === 'text')
  if (!textPart || textPart.type !== 'text') {
    throw new Error('Expected text content part')
  }

  return textPart.text
}

function createMockApp({
  files,
  folders,
  fileContents,
  frontmatters,
}: {
  files: InstanceType<typeof TFile>[]
  folders?: InstanceType<typeof TFolder>[]
  fileContents: Map<string, string>
  frontmatters?: Map<string, Record<string, unknown>>
}) {
  const folderEntries = folders ?? []
  const fileFrontmatters = frontmatters ?? new Map()

  return {
    metadataCache: {
      getFileCache: jest.fn((file: { path: string }) => {
        const frontmatter = fileFrontmatters.get(file.path)
        return frontmatter ? { frontmatter } : null
      }),
    },
    vault: {
      cachedRead: jest.fn(async (file: { path: string }) => {
        return fileContents.get(file.path) ?? ''
      }),
      getFileByPath: jest.fn((path: string) => {
        return files.find((file) => file.path === path) ?? null
      }),
      getFolderByPath: jest.fn((path: string) => {
        return folderEntries.find((folder) => folder.path === path) ?? null
      }),
    },
  }
}

describe('extractMarkdownAtxHeadings', () => {
  it('extracts ATX headings and ignores fenced code blocks', () => {
    const content = [
      '# Intro',
      '',
      '```ts',
      '# not-a-heading',
      '```',
      '## Details ###',
      'text',
      '~~~md',
      '### still-not-a-heading',
      '~~~',
      '#### Final',
    ].join('\n')

    expect(extractMarkdownAtxHeadings(content)).toEqual([
      { level: 1, line: 1, text: 'Intro' },
      { level: 2, line: 6, text: 'Details' },
      { level: 4, line: 11, text: 'Final' },
    ])
  })
})

describe('RequestContextBuilder compileUserMessagePrompt', () => {
  const settings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    chatOptions: {
      includeCurrentFileContent: true,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as SmartComposerSettings

  it('builds unified mentioned file context with outlines for files, current file, and folder files', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const currentFile = createMockFile('notes/current.md')
    const folderFile = createMockFile('docs/from-folder.md')
    const textFile = createMockFile('docs/plain.txt')
    const folder = createMockFolder('docs', [folderFile, textFile])

    const fileContents = new Map<string, string>([
      [explicitFile.path, '# Explicit\n## Part A'],
      [currentFile.path, '# Current'],
      [folderFile.path, '## Folder Heading'],
      [textFile.path, 'plain text content'],
    ])
    const frontmatters = new Map<string, Record<string, unknown>>([
      [
        explicitFile.path,
        {
          title: 'Explicit Title',
          tags: ['alpha', 'beta'],
        },
      ],
      [
        folderFile.path,
        {
          exported_from: 'YOLO',
        },
      ],
    ])

    const app = createMockApp({
      files: [explicitFile, currentFile, folderFile, textFile],
      folders: [folder],
      fileContents,
      frontmatters,
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'current-file', file: currentFile },
        { type: 'folder', folder },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('## Mentioned Vault Files (outline only)')
    expect(textContent).toContain(
      [
        '- `notes/explicit.md`',
        '  - Properties:',
        '    - `title`: `Explicit Title`',
        '    - `tags`: `["alpha","beta"]`',
        '  - L1 # Explicit',
        '  - L2 ## Part A',
      ].join('\n'),
    )
    expect(textContent).toContain('- `notes/current.md`\n  - L1 # Current')
    expect(textContent).toContain(
      [
        '- `docs/from-folder.md`',
        '  - Properties:',
        '    - `exported_from`: `YOLO`',
        '  - L1 ## Folder Heading',
      ].join('\n'),
    )
    expect(textContent).toContain('- `docs/plain.txt`')
    expect(textContent).toContain('## Mentioned Vault Folders\n- `docs`')
    expect(textContent).toContain(
      'This section provides only paths and outlines. Use file tools only if you need the full contents or a specific line range.',
    )
  })

  it('caps markdown outlines and reports omitted files', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const folderFiles = Array.from({ length: 11 }, (_, index) =>
      createMockFile(`docs/file-${index + 1}.md`),
    )
    const folder = createMockFolder('docs', folderFiles)

    const fileContents = new Map<string, string>([
      [explicitFile.path, '# Explicit'],
      ...folderFiles.map(
        (file, index) => [file.path, `# Folder ${index + 1}`] as const,
      ),
    ])

    const app = createMockApp({
      files: [explicitFile, ...folderFiles],
      folders: [folder],
      fileContents,
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'folder', folder },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent.match(/- L1 # /g)?.length).toBe(10)
    expect(textContent).toContain(
      'Additional mentioned markdown files omitted from outline due to limit: 2',
    )
  })

  it('uses light mode by default for mentioned files even without tool-read preference', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const currentFile = createMockFile('notes/current.md')

    const fileContents = new Map<string, string>([
      [explicitFile.path, '# Explicit\nBody'],
      [currentFile.path, '# Current\nMore'],
    ])

    const app = createMockApp({
      files: [explicitFile, currentFile],
      fileContents,
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'current-file', file: currentFile },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('- `notes/explicit.md`\n  - L1 # Explicit')
    expect(textContent).toContain('- `notes/current.md`\n  - L1 # Current')
    expect(textContent).not.toContain('Body')
    expect(textContent).not.toContain('More')
  })

  it('includes frontmatter properties without internal metadata fields', async () => {
    const explicitFile = createMockFile('notes/with-properties.md')

    const app = createMockApp({
      files: [explicitFile],
      fileContents: new Map([[explicitFile.path, '# Heading']]),
      frontmatters: new Map([
        [
          explicitFile.path,
          {
            title: '工具上下文管理详解',
            exported_at: '2026-04-09T12:10:14.480Z',
            draft: false,
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 4, col: 3, offset: 80 },
            },
          },
        ],
      ]),
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'file', file: explicitFile }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('    - `title`: `工具上下文管理详解`')
    expect(textContent).toContain(
      '    - `exported_at`: `2026-04-09T12:10:14.480Z`',
    )
    expect(textContent).toContain('    - `draft`: `false`')
    expect(textContent).not.toContain('`position`')
  })

  it('uses full content for files and current file in full mode while keeping folders light', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const currentFile = createMockFile('notes/current.md')
    const folderFile = createMockFile('docs/from-folder.md')
    const folder = createMockFolder('docs', [folderFile])

    const fileContents = new Map<string, string>([
      [explicitFile.path, '# Explicit\nBody'],
      [currentFile.path, '# Current\nMore'],
      [folderFile.path, '## Folder Heading\nFolder body'],
    ])

    const app = createMockApp({
      files: [explicitFile, currentFile, folderFile],
      folders: [folder],
      fileContents,
    })

    const builder = new RequestContextBuilder(
      app as never,
      {
        ...settings,
        chatOptions: {
          includeCurrentFileContent: true,
          mentionContextMode: 'full',
        },
      } as unknown as SmartComposerSettings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'current-file', file: currentFile },
        { type: 'folder', folder },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain(
      '## Mentioned Vault Files (full content already provided below)',
    )
    expect(textContent).toContain(
      'Use this provided content first. Only call file tools if you need another file or want to verify the latest contents.',
    )
    expect(textContent).toContain(
      '```notes/explicit.md\n1|# Explicit\n2|Body\n```',
    )
    expect(textContent).toContain(
      '```notes/current.md\n1|# Current\n2|More\n```',
    )
    expect(textContent).toContain('## Mentioned Vault Folders\n- `docs`')
    expect(textContent).toContain(
      '- `docs/from-folder.md`\n  - L1 ## Folder Heading',
    )
    expect(textContent).not.toContain('Folder body')
  })

  it('uses only the latest valid current-file mention when old current-file references accumulated', async () => {
    const staleCurrentFile = createMockFile('notes/stale.md')
    const latestCurrentFile = createMockFile('notes/latest.md')

    const fileContents = new Map<string, string>([
      [staleCurrentFile.path, '# Stale'],
      [latestCurrentFile.path, '# Latest'],
    ])

    const app = createMockApp({
      files: [staleCurrentFile, latestCurrentFile],
      fileContents,
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'current-file', file: staleCurrentFile },
        { type: 'current-file', file: null },
        { type: 'current-file', file: latestCurrentFile },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('- `notes/latest.md`\n  - L1 # Latest')
    expect(textContent).not.toContain('notes/stale.md')
  })
})

describe('RequestContextBuilder generateRequestMessages', () => {
  const settings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    yolo: { baseDir: 'YOLO' },
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as SmartComposerSettings

  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  it('hides pruned tool results from future request context', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
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
          id: 'assistant-tool',
          content: '',
          toolCallRequests: [
            {
              id: 'edit-1',
              name: 'yolo_local__fs_edit',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-edit',
          toolCalls: [
            {
              request: {
                id: 'edit-1',
                name: 'yolo_local__fs_edit',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'fs_edit',
                    path: 'note.md',
                    status: 'ok',
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'assistant',
          id: 'assistant-prune',
          content: '',
          toolCallRequests: [
            {
              id: 'prune-1',
              name: 'yolo_local__context_prune_tool_results',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-prune',
          toolCalls: [
            {
              request: {
                id: 'prune-1',
                name: 'yolo_local__context_prune_tool_results',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_prune_tool_results',
                    operation: 'prune_selected',
                    acceptedToolCallIds: ['edit-1'],
                    ignoredToolCallIds: [],
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'follow-up prompt',
          mentionables: [],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
    })

    expect(
      requestMessages.some(
        (message) =>
          message.role === 'tool' && message.tool_call.id === 'edit-1',
      ),
    ).toBe(false)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' &&
          (message.tool_calls ?? []).some(
            (toolCall) => toolCall.id === 'edit-1',
          ),
      ),
    ).toBe(false)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'tool' && message.tool_call.id === 'prune-1',
      ),
    ).toBe(true)
  })

  it('injects compact summary and retains the latest assistant tool boundary', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old answer',
        },
        {
          role: 'assistant',
          id: 'assistant-tools',
          content: 'checking files',
          toolCallRequests: [
            {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-compact',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_compact',
                    toolCallId: 'compact-1',
                    operation: 'compact_restart',
                  }),
                },
              },
            },
          ],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: {
        anchorMessageId: 'tool-compact',
        summary: 'Earlier history summary',
        compactedAt: 1,
        triggerToolCallId: 'compact-1',
      },
    })

    expect(requestMessages[1]).toEqual({
      role: 'user',
      content: expect.stringContaining('Earlier history summary'),
    })
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' && message.content === 'checking files',
      ),
    ).toBe(true)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'tool' && message.tool_call.id === 'compact-1',
      ),
    ).toBe(true)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' && message.content === 'old answer',
      ),
    ).toBe(false)
    expect(requestMessages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining(
        'Resume the task that was active immediately before compaction.',
      ),
    })
  })

  it('does not append compact resume instruction after a new user turn', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-tools',
          content: 'checking files',
          toolCallRequests: [
            {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-compact',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_compact',
                    toolCallId: 'compact-1',
                    operation: 'compact_restart',
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'new turn after compact',
          mentionables: [],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: {
        anchorMessageId: 'tool-compact',
        summary: 'Earlier history summary',
        compactedAt: 1,
        triggerToolCallId: 'compact-1',
      },
    })

    expect(requestMessages.at(-1)).toEqual({
      role: 'user',
      content: 'new turn after compact',
    })
  })

  it('injects manual compaction summary even without a compact tool boundary', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old answer',
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: {
        anchorMessageId: 'assistant-1',
        summary: 'Earlier history summary',
        compactedAt: 1,
      },
    })

    expect(requestMessages[1]).toEqual({
      role: 'user',
      content: expect.stringContaining('Earlier history summary'),
    })
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' && message.content === 'old answer',
      ),
    ).toBe(false)
    expect(requestMessages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining(
        'Resume the task that was active immediately before compaction.',
      ),
    })
  })

  it('uses the latest compaction entry when multiple compactions exist', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old answer',
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'new follow-up',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-2',
          content: 'new answer',
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: [
        {
          anchorMessageId: 'assistant-1',
          summary: 'Earlier history summary',
          compactedAt: 1,
        },
        {
          anchorMessageId: 'assistant-2',
          summary: 'Latest history summary',
          compactedAt: 2,
        },
      ],
    })

    expect(requestMessages[1]).toEqual({
      role: 'user',
      content: expect.stringContaining('Latest history summary'),
    })
    expect(requestMessages[1]).not.toEqual({
      role: 'user',
      content: expect.stringContaining('Earlier history summary'),
    })
  })

  it('does not reuse an older compact tool boundary after a newer manual compaction', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old answer',
        },
        {
          role: 'assistant',
          id: 'assistant-tools',
          content: '好的，我来帮您压缩上下文。',
          toolCallRequests: [
            {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-compact',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_compact',
                    toolCallId: 'compact-1',
                    operation: 'compact_restart',
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'assistant',
          id: 'assistant-after-compact',
          content: '上下文压缩已完成。现在我们可以继续工作了。',
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: '在吗',
          mentionables: [],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: [
        {
          anchorMessageId: 'tool-compact',
          summary: 'Earlier history summary',
          compactedAt: 1,
          triggerToolCallId: 'compact-1',
        },
        {
          anchorMessageId: 'assistant-after-compact',
          summary: 'Latest manual summary',
          compactedAt: 2,
        },
      ],
    })

    expect(requestMessages).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Latest manual summary'),
      }),
      {
        role: 'user',
        content: '在吗',
      },
    ])
  })

  it('keeps compaction history within the recent context window', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'user-before',
          content: null,
          promptContent: 'old question before compact',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-tools',
          content: 'checking files',
          toolCallRequests: [
            {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-compact',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_compact',
                    toolCallId: 'compact-1',
                    operation: 'compact_restart',
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'follow-up 1',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-2',
          content: 'answer 1',
        },
        {
          role: 'user',
          id: 'user-3',
          content: null,
          promptContent: 'follow-up 2',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-3',
          content: 'answer 2',
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      maxContextOverride: 2,
      compaction: {
        anchorMessageId: 'tool-compact',
        summary: 'Earlier history summary',
        compactedAt: 1,
        triggerToolCallId: 'compact-1',
      },
    })

    expect(requestMessages[1]).toEqual({
      role: 'user',
      content: expect.stringContaining('Earlier history summary'),
    })
    expect(requestMessages).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Earlier history summary'),
      }),
      {
        role: 'user',
        content: 'follow-up 2',
      },
      {
        role: 'assistant',
        content: 'answer 2',
      },
    ])
  })
})
