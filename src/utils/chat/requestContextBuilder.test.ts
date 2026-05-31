import { TFile, TFolder } from 'obsidian'

jest.mock('../../database/json/chat/promptSnapshotStore', () => ({
  readPromptSnapshotEntries: jest.fn(async () => ({})),
}))

jest.mock('../../core/memory/memoryManager', () => ({
  getMemoryPromptContext: jest.fn(async () => ''),
  resolveMemoryFilePaths: jest.fn(() => ({
    global: 'YOLO/memory/global.md',
    assistant: null,
  })),
}))

jest.mock('../llm/image', () => ({
  isImageTFile: jest.fn(() => false),
  tFileToImageDataUrl: jest.fn(async () => 'data:image/png;base64,fake'),
}))

import { SystemPromptSnapshotStore } from '../../core/agent/systemPromptSnapshotStore'
import { getMemoryPromptContext } from '../../core/memory/memoryManager'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatUserMessage } from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { ContentPart, RequestMessage } from '../../types/llm/request'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { createCompleteToolCallArguments } from '../../types/tool-call.types'

import {
  RequestContextBuilder,
  extractMarkdownAtxHeadings,
  stripUnsupportedImages,
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
  } as unknown as YoloSettings

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
    // current-file is no longer surfaced via the mention path.
    expect(textContent).not.toContain('notes/current.md')
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
      message: createUserMessage([{ type: 'file', file: explicitFile }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('- `notes/explicit.md`\n  - L1 # Explicit')
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

  it('uses full content for explicit files in full mode', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const folderFile = createMockFile('docs/from-folder.md')
    const folder = createMockFolder('docs', [folderFile])

    const fileContents = new Map<string, string>([
      [explicitFile.path, '# Explicit\nBody'],
      [folderFile.path, '## Folder Heading\nFolder body'],
    ])

    const app = createMockApp({
      files: [explicitFile, folderFile],
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
      } as unknown as YoloSettings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'folder', folder },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain(
      '## Mentioned Vault Files (full content already provided below)',
    )
    expect(textContent).toContain('- `notes/explicit.md` (2 lines)')
    expect(textContent).toContain(
      'Do NOT call any file-reading tool (e.g. read_file) to re-read them',
    )
    expect(textContent).toContain(
      '### `notes/explicit.md` (full content, 2 lines)',
    )
    expect(textContent).toContain(
      '```notes/explicit.md\n1|# Explicit\n2|Body\n```',
    )
    expect(textContent).toContain('## Mentioned Vault Folders\n- `docs`')
    expect(textContent).toContain(
      '- `docs/from-folder.md`\n  - L1 ## Folder Heading',
    )
    expect(textContent).not.toContain('Folder body')
  })

  it('omits the full-content section when all mentioned files fail to read', async () => {
    const explicitFile = createMockFile('notes/unreadable.md')

    const app = createMockApp({
      files: [explicitFile],
      fileContents: new Map(),
    })
    ;(app.vault.cachedRead as jest.Mock).mockImplementation(async () => {
      throw new Error('forced read failure')
    })

    const builder = new RequestContextBuilder(
      app as never,
      {
        ...settings,
        chatOptions: {
          includeCurrentFileContent: true,
          mentionContextMode: 'full',
        },
      } as unknown as YoloSettings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'file', file: explicitFile }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).not.toContain(
      '## Mentioned Vault Files (full content already provided below)',
    )
    expect(textContent).not.toContain('### `notes/unreadable.md`')
  })

  it('reports zero lines for empty files in full mode', async () => {
    const emptyFile = createMockFile('notes/empty.md')

    const app = createMockApp({
      files: [emptyFile],
      fileContents: new Map([[emptyFile.path, '']]),
    })

    const builder = new RequestContextBuilder(
      app as never,
      {
        ...settings,
        chatOptions: {
          includeCurrentFileContent: true,
          mentionContextMode: 'full',
        },
      } as unknown as YoloSettings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'file', file: emptyFile }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('- `notes/empty.md` (0 lines)')
    expect(textContent).toContain(
      '### `notes/empty.md` (full content, 0 lines)',
    )
    expect(textContent).toContain('```notes/empty.md\n\n```')
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
  } as unknown as YoloSettings

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
      systemPromptSnapshotMode: 'create',
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
      systemPromptSnapshotMode: 'create',
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
      systemPromptSnapshotMode: 'create',
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
      systemPromptSnapshotMode: 'create',
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
      systemPromptSnapshotMode: 'create',
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
      systemPromptSnapshotMode: 'create',
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

  it('preserves all messages when history exceeds 32', async () => {
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

    // Build 34 messages (17 user + 17 assistant alternating), first user is the one we track
    const historyMessages: Parameters<
      typeof builder.generateRequestMessages
    >[0]['messages'] = []
    for (let i = 0; i < 34; i++) {
      if (i % 2 === 0) {
        historyMessages.push({
          role: 'user',
          id: `user-${i}`,
          content: null,
          promptContent: i === 0 ? 'first user message' : `user message ${i}`,
          mentionables: [],
        })
      } else {
        historyMessages.push({
          role: 'assistant',
          id: `assistant-${i}`,
          content: `assistant reply ${i}`,
        })
      }
    }

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: historyMessages,
      hasTools: false,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-truncation-regression',
    })

    const systemMessages = requestMessages.filter((m) => m.role === 'system')
    const nonSystemMessages = requestMessages.filter((m) => m.role !== 'system')

    // No truncation: total = system + all 34 history messages
    expect(requestMessages).toHaveLength(systemMessages.length + 34)

    // First non-system message must be the earliest user message
    expect(nonSystemMessages[0]).toEqual({
      role: 'user',
      content: 'first user message',
    })
  })
})

describe('RequestContextBuilder project instructions injection', () => {
  function makeApp(rootFiles: Map<string, string>) {
    return {
      metadataCache: { getFileCache: jest.fn(() => null) },
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
        cachedRead: jest.fn(async (file: { path: string }) => {
          return rootFiles.get(file.path) ?? ''
        }),
        getAbstractFileByPath: jest.fn((path: string) => {
          if (!rootFiles.has(path)) return null
          const file = Object.assign(new TFile(), { path })
          ;(
            file as unknown as { parent: InstanceType<typeof TFolder> }
          ).parent = Object.assign(new TFolder(), { path: '', parent: null })
          return file
        }),
        getRoot: jest.fn(() =>
          Object.assign(new TFolder(), { path: '', parent: null }),
        ),
        getFileByPath: jest.fn(() => null),
        getFolderByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
      },
    }
  }

  const baseSettings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    chatOptions: {
      includeCurrentFileContent: true,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  async function buildSystemContent(
    app: ReturnType<typeof makeApp>,
    settings: YoloSettings,
  ): Promise<string> {
    const builder = new RequestContextBuilder(app as never, settings)
    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'hi',
          mentionables: [],
        },
      ],
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conv-pi',
    })
    const system = requestMessages.find((m) => m.role === 'system')
    expect(system).toBeDefined()
    return typeof system!.content === 'string' ? system!.content : ''
  }

  it('does not inject project instructions by default (no assistant selected)', async () => {
    const app = makeApp(
      new Map([
        ['AGENTS.md', 'rule from agents'],
        ['CLAUDE.md', 'rule from claude'],
      ]),
    )
    const content = await buildSystemContent(app, baseSettings)
    expect(content).not.toContain('## Project instructions: AGENTS.md')
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
  })

  it('injects AGENTS.md and CLAUDE.md when current assistant enables it explicitly', async () => {
    const app = makeApp(
      new Map([
        ['AGENTS.md', 'rule from agents'],
        ['CLAUDE.md', 'rule from claude'],
      ]),
    )
    const settings = {
      ...baseSettings,
      currentAssistantId: 'a-1',
      assistants: [
        {
          id: 'a-1',
          name: 'Enabled',
          systemPrompt: '',
          enableProjectInstructions: true,
        },
      ],
    } as unknown as YoloSettings
    const content = await buildSystemContent(app, settings)
    expect(content).toContain('## Project instructions: AGENTS.md')
    expect(content).toContain('rule from agents')
    expect(content).toContain('## Project instructions: CLAUDE.md')
    expect(content).toContain('rule from claude')
    // Project instructions should appear after the base behavior section,
    // not as the first thing in the system message.
    const projectIdx = content.indexOf('project instructions in the vault')
    expect(projectIdx).toBeGreaterThan(0)
  })

  it('omits project instructions when current assistant disables it explicitly', async () => {
    const app = makeApp(new Map([['CLAUDE.md', 'rule from claude']]))
    const settings = {
      ...baseSettings,
      currentAssistantId: 'a-1',
      assistants: [
        {
          id: 'a-1',
          name: 'Disabled',
          systemPrompt: '',
          enableProjectInstructions: false,
        },
      ],
    } as unknown as YoloSettings
    const content = await buildSystemContent(app, settings)
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
    expect(content).not.toContain('rule from claude')
  })

  it('defaults to disabled when currentAssistantId points to a non-existent assistant', async () => {
    const app = makeApp(new Map([['CLAUDE.md', 'rule from claude']]))
    const settings = {
      ...baseSettings,
      currentAssistantId: 'missing-id',
      assistants: [
        {
          id: 'other-id',
          name: 'Other',
          systemPrompt: '',
          enableProjectInstructions: true,
        },
      ],
    } as unknown as YoloSettings
    const content = await buildSystemContent(app, settings)
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
    expect(content).not.toContain('rule from claude')
  })

  it('defaults to disabled when assistant exists but enableProjectInstructions is undefined', async () => {
    const app = makeApp(new Map([['CLAUDE.md', 'rule from claude']]))
    const settings = {
      ...baseSettings,
      currentAssistantId: 'a-1',
      assistants: [{ id: 'a-1', name: 'Default', systemPrompt: '' }],
    } as unknown as YoloSettings
    const content = await buildSystemContent(app, settings)
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
  })

  it('omits project instructions section when neither file exists', async () => {
    const app = makeApp(new Map())
    const content = await buildSystemContent(app, baseSettings)
    expect(content).not.toContain('## Project instructions: AGENTS.md')
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
    expect(content).not.toContain('project instructions in the vault')
  })
})

describe('RequestContextBuilder generateRequestMessages currentFile merging', () => {
  const baseSettings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    chatOptions: {
      includeCurrentFileContent: true,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  function makeApp() {
    return {
      metadataCache: { getFileCache: jest.fn(() => null) },
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
        cachedRead: jest.fn(async () => ''),
        getFileByPath: jest.fn(() => null),
        getFolderByPath: jest.fn(() => null),
      },
    }
  }

  it('merges currentFileMessage into last user message content parts when last history message is user', async () => {
    const app = makeApp()
    const builder = new RequestContextBuilder(app as never, baseSettings)
    const currentFile = createMockFile('notes/focus.md')

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'hello',
          mentionables: [],
        },
      ],
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conv-1',
      contextualInjections: [
        { type: 'current-file-pointer', file: currentFile },
      ],
    })

    // Should have system + 1 user (not system + 2 user)
    const userMessages = requestMessages.filter((m) => m.role === 'user')
    expect(userMessages).toHaveLength(1)

    // The single user message content must be an array (merged ContentPart[])
    const lastUser = userMessages[0]
    expect(Array.isArray(lastUser.content)).toBe(true)
    const parts = lastUser.content as Array<{ type: string; text?: string }>
    const textParts = parts.filter((p) => p.type === 'text')
    // Original promptContent text
    expect(textParts.some((p) => p.text?.includes('hello'))).toBe(true)
    // Current-file pointer text
    expect(textParts.some((p) => p.text?.includes('notes/focus.md'))).toBe(true)
  })

  it('appends currentFileMessage as independent user message when last history message is not user (agent loop continuation)', async () => {
    const app = makeApp()
    const emptyArgs = createCompleteToolCallArguments({ value: {} })
    const builder = new RequestContextBuilder(app as never, baseSettings)
    const currentFile = createMockFile('notes/focus.md')

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'do something',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: '',
          toolCallRequests: [
            {
              id: 'tool-call-1',
              name: 'yolo_local__fs_read',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-1',
          toolCalls: [
            {
              request: {
                id: 'tool-call-1',
                name: 'yolo_local__fs_read',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: 'file content' },
              },
            },
          ],
        },
      ],
      hasTools: true,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conv-2',
      contextualInjections: [
        { type: 'current-file-pointer', file: currentFile },
      ],
    })

    // Last message should be an independent user message containing the current-file pointer
    const lastMsg = requestMessages.at(-1)
    expect(lastMsg?.role).toBe('user')
    const content = lastMsg?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('')
          : ''
    expect(text).toContain('notes/focus.md')

    // The original user message should still exist separately
    const userMessages = requestMessages.filter((m) => m.role === 'user')
    expect(userMessages.length).toBeGreaterThanOrEqual(2)
  })
})

describe('stripUnsupportedImages', () => {
  const visionModel = {
    id: 'v/vision',
    modalities: ['text', 'vision'],
  } as unknown as ChatModel

  const textOnlyModel = {
    id: 'v/text',
    modalities: ['text'],
  } as unknown as ChatModel

  const imageUrlPart: ContentPart = {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAA' },
  }
  const textPart: ContentPart = { type: 'text', text: 'hello' }

  it('returns messages unchanged when model supports vision', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [imageUrlPart, textPart] },
    ]
    expect(stripUnsupportedImages(messages, visionModel)).toBe(messages)
  })

  it('replaces image_url parts with placeholder text for text-only model', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [imageUrlPart, textPart] },
    ]
    const result = stripUnsupportedImages(messages, textOnlyModel)
    expect(result).not.toBe(messages)
    const content = result[0]?.content as ContentPart[]
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({
      type: 'text',
      text: '[图片已省略：模型不支持视觉]',
    })
    expect(content[1]).toEqual(textPart)
  })

  it('handles user message that is all images — result has only placeholder text parts', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [imageUrlPart, imageUrlPart] },
    ]
    const result = stripUnsupportedImages(messages, textOnlyModel)
    const content = result[0]?.content as ContentPart[]
    expect(content).toHaveLength(2)
    expect(content.every((p) => p.type === 'text')).toBe(true)
  })

  it('does not touch messages whose content is a string', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: 'plain text' },
      { role: 'system', content: 'system prompt' },
    ]
    const result = stripUnsupportedImages(messages, textOnlyModel)
    expect(result[0]?.content).toBe('plain text')
    expect(result[1]?.content).toBe('system prompt')
  })

  it('strips images from a user message appended after tool calls (tool image path)', () => {
    // Images from tool calls are appended as a user message with content array
    const messages: RequestMessage[] = [
      {
        role: 'tool',
        tool_call: {
          id: 'tc1',
          name: 'fs_read',
          arguments: createCompleteToolCallArguments({ value: {} }),
        },
        content: 'text result',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Images from tool call: fs_read]' },
          imageUrlPart,
        ],
      },
    ]
    const result = stripUnsupportedImages(messages, textOnlyModel)
    // tool message untouched (string content)
    expect(result[0]?.content).toBe('text result')
    // user message: image replaced
    const userContent = result[1]?.content as ContentPart[]
    expect(userContent[1]).toEqual({
      type: 'text',
      text: '[图片已省略：模型不支持视觉]',
    })
  })

  it('strips images when model is null (conservative: unknown model treated as text-only)', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [imageUrlPart] },
    ]
    // null model → chatModelSupportsVision returns false → images stripped
    const result = stripUnsupportedImages(messages, null)
    const content = result[0]?.content as ContentPart[]
    expect(content[0]).toEqual({
      type: 'text',
      text: '[图片已省略：模型不支持视觉]',
    })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// parseToolMessage document hoisting
// ──────────────────────────────────────────────────────────────────────────────

describe('parseToolMessage document hoisting', () => {
  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  const mockApp = {
    vault: {
      adapter: {
        exists: jest.fn().mockResolvedValue(false),
        mkdir: jest.fn().mockResolvedValue(undefined),
        read: jest.fn().mockResolvedValue(''),
        write: jest.fn().mockResolvedValue(undefined),
      },
    },
  }

  const mockSettings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    yolo: { baseDir: 'YOLO' },
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
    // A PDF-capable model so prepareDocumentsForModel doesn't strip document parts.
    chatModels: [
      {
        id: 'pdf-provider/pdf-model',
        providerId: 'pdf-provider',
        model: 'pdf-model',
        modalities: ['text', 'vision', 'pdf'],
      },
    ],
  } as unknown as YoloSettings

  // Use this model ID when building request messages so the PDF modality gate passes.
  const PDF_MODEL_ID = 'pdf-provider/pdf-model'

  /**
   * Build a minimal conversation with one assistant turn (with tool calls),
   * one tool response turn carrying the given contentParts, and a final user
   * message. Returns the generated request messages.
   */
  const buildMessagesWithToolResponse = async (
    toolName: string,
    contentParts: ContentPart[],
  ) => {
    const builder = new RequestContextBuilder(mockApp as never, mockSettings)
    return builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'read some file',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'asst-1',
          content: 'ok',
          toolCallRequests: [
            {
              id: 'tc-1',
              name: toolName,
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-1',
          toolCalls: [
            {
              request: {
                id: 'tc-1',
                name: toolName,
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: 'tool result text',
                  contentParts,
                },
              },
            },
          ],
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'follow-up',
          mentionables: [],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      // Use a PDF-capable model so prepareDocumentsForModel passes document parts through.
      model: {
        id: PDF_MODEL_ID,
        providerId: 'pdf-provider',
        model: 'pdf-model',
        name: 'pdf-model',
        modalities: ['text', 'vision', 'pdf'],
      } as never,
      conversationId: 'conv-doc-hoist',
    })
  }

  it('hoists document part from tool response into follow-up user message', async () => {
    const documentPart: ContentPart = {
      type: 'document',
      mediaType: 'application/pdf',
      name: 'report.pdf (pages 1–3)',
      data: 'base64data',
      pageCount: 3,
    }

    const messages = await buildMessagesWithToolResponse(
      'yolo_local__fs_read',
      [documentPart],
    )

    // There should be a user message with the document part and a header label.
    const userMessages = messages.filter((m) => m.role === 'user')
    const hoistMsg = userMessages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'document'),
    )
    expect(hoistMsg).toBeDefined()
    const content = hoistMsg!.content as ContentPart[]
    const headerPart = content.find((p) => p.type === 'text')
    expect(headerPart?.type === 'text' && headerPart.text).toContain(
      'PDF attachments from tool call',
    )
    expect(headerPart?.type === 'text' && headerPart.text).toContain(
      'yolo_local__fs_read',
    )
    const docPart = content.find((p) => p.type === 'document')
    expect(docPart).toEqual(documentPart)
  })

  it('hoists image_url part alone → header is "Images from tool call"', async () => {
    const imagePart: ContentPart = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' },
    }

    const messages = await buildMessagesWithToolResponse(
      'yolo_local__fs_read',
      [imagePart],
    )

    const userMessages = messages.filter((m) => m.role === 'user')
    const hoistMsg = userMessages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url'),
    )
    expect(hoistMsg).toBeDefined()
    const content = hoistMsg!.content as ContentPart[]
    const headerPart = content.find((p) => p.type === 'text')
    expect(headerPart?.type === 'text' && headerPart.text).toContain(
      'Images from tool call',
    )
  })

  it('mixed image + document → header is "Attachments from tool call"', async () => {
    const imagePart: ContentPart = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,BBB' },
    }
    const documentPart: ContentPart = {
      type: 'document',
      mediaType: 'application/pdf',
      name: 'file.pdf',
      data: 'base64',
    }

    const messages = await buildMessagesWithToolResponse(
      'yolo_local__fs_read',
      [imagePart, documentPart],
    )

    const userMessages = messages.filter((m) => m.role === 'user')
    const hoistMsg = userMessages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url' || p.type === 'document'),
    )
    expect(hoistMsg).toBeDefined()
    const content = hoistMsg!.content as ContentPart[]
    const headerPart = content.find((p) => p.type === 'text')
    expect(headerPart?.type === 'text' && headerPart.text).toContain(
      'Attachments from tool call',
    )
  })
})

describe('RequestContextBuilder system prompt freezing', () => {
  const baseSettings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    yolo: { baseDir: 'YOLO' },
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  const model = {
    provider: 'openai',
    model: 'gpt-test',
    name: 'gpt-test',
  } as never

  const userMessages: ChatUserMessage[] = [
    {
      role: 'user',
      id: 'u1',
      content: null,
      promptContent: 'hello',
      mentionables: [],
    },
  ]

  const memMock = jest.mocked(getMemoryPromptContext)

  const makeApp = () =>
    createMockApp({ files: [], fileContents: new Map() }) as never

  const getSystemContent = (messages: RequestMessage[]): string => {
    const system = messages.find((message) => message.role === 'system')
    if (!system || typeof system.content !== 'string') {
      throw new Error('Expected a string system message')
    }
    return system.content
  }

  afterAll(() => {
    memMock.mockResolvedValue({ global: null, assistant: null })
  })

  it('freezes memory in the system prompt for the conversation lifetime (create mode)', async () => {
    const store = new SystemPromptSnapshotStore()
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })

    memMock.mockResolvedValue({ global: 'MEM_V1', assistant: null })
    memMock.mockClear()

    const first = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(first)).toContain('MEM_V1')

    // Memory is rewritten mid-conversation (e.g. a memory_add tool call).
    memMock.mockResolvedValue({ global: 'MEM_V2', assistant: null })

    const second = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    // Frozen: still V1, and memory was not re-read for the second iteration.
    expect(getSystemContent(second)).toContain('MEM_V1')
    expect(getSystemContent(second)).not.toContain('MEM_V2')
    expect(memMock).toHaveBeenCalledTimes(1)

    // A fresh conversation picks up the latest memory.
    const other = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-2',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(other)).toContain('MEM_V2')
  })

  it('refreshes the snapshot when a prompt-relevant setting changes', async () => {
    const store = new SystemPromptSnapshotStore()
    memMock.mockResolvedValue({ global: 'MEM', assistant: null })

    const builderA = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })
    const a = await builderA.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(a)).not.toContain('CUSTOM_SP')

    // settings.systemPrompt changes -> fingerprint changes -> snapshot refreshes
    // even within the same conversationId (a new RCB instance, shared store).
    const builderB = new RequestContextBuilder(
      makeApp(),
      { ...baseSettings, systemPrompt: 'CUSTOM_SP' } as unknown as YoloSettings,
      { includeSkills: false, systemPromptSnapshotStore: store },
    )
    const b = await builderB.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(b)).toContain('CUSTOM_SP')
  })

  it('does NOT refresh the snapshot for a setting that never reaches the system prompt', async () => {
    const store = new SystemPromptSnapshotStore()
    memMock.mockResolvedValue({ global: 'MEM_V1', assistant: null })

    const builderA = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })
    const a = await builderA.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(a)).toContain('MEM_V1')

    // Memory changes AND an unrelated, non-system setting (chatOptions) changes.
    // The fingerprint must be unchanged, so the frozen V1 snapshot is kept.
    memMock.mockResolvedValue({ global: 'MEM_V2', assistant: null })
    const builderB = new RequestContextBuilder(
      makeApp(),
      {
        ...baseSettings,
        chatOptions: {
          includeCurrentFileContent: true,
          mentionContextMode: 'full',
        },
      } as unknown as YoloSettings,
      { includeSkills: false, systemPromptSnapshotStore: store },
    )
    const b = await builderB.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(b)).toContain('MEM_V1')
    expect(getSystemContent(b)).not.toContain('MEM_V2')
  })

  it('reuse mode never freezes ahead of the real request', async () => {
    const store = new SystemPromptSnapshotStore()
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })

    memMock.mockResolvedValue({ global: 'MEM_V1', assistant: null })
    const estimate = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'reuse',
    })
    expect(getSystemContent(estimate)).toContain('MEM_V1')

    // The estimate must not have frozen V1: the real request sees current memory.
    memMock.mockResolvedValue({ global: 'MEM_V2', assistant: null })
    const real = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(real)).toContain('MEM_V2')
  })
})
