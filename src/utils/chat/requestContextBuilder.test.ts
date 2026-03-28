import { TFile, TFolder } from 'obsidian'

import type { ChatUserMessage } from '../../types/chat'
import type { SmartComposerSettings } from '../../settings/schema/setting.types'

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
}: {
  files: InstanceType<typeof TFile>[]
  folders?: InstanceType<typeof TFolder>[]
  fileContents: Map<string, string>
}) {
  const folderEntries = folders ?? []

  return {
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

    const app = createMockApp({
      files: [explicitFile, currentFile, folderFile, textFile],
      folders: [folder],
      fileContents,
    })

    const builder = new RequestContextBuilder(
      async () => {
        throw new Error('RAG should not be called in this test')
      },
      app as never,
      settings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'current-file', file: currentFile },
        { type: 'folder', folder },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('## Mentioned Vault Files (outline only)')
    expect(textContent).toContain('- `notes/explicit.md`\n  - L1 # Explicit\n  - L2 ## Part A')
    expect(textContent).toContain('- `notes/current.md`\n  - L1 # Current')
    expect(textContent).toContain('- `docs/from-folder.md`\n  - L1 ## Folder Heading')
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
      ...folderFiles.map((file, index) => [
        file.path,
        `# Folder ${index + 1}`,
      ] as const),
    ])

    const app = createMockApp({
      files: [explicitFile, ...folderFiles],
      folders: [folder],
      fileContents,
    })

    const builder = new RequestContextBuilder(
      async () => {
        throw new Error('RAG should not be called in this test')
      },
      app as never,
      settings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'folder', folder },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(
      textContent.match(/- L1 # /g)?.length,
    ).toBe(10)
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

    const builder = new RequestContextBuilder(
      async () => {
        throw new Error('RAG should not be called in this test')
      },
      app as never,
      settings,
    )

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
      async () => {
        throw new Error('RAG should not be called in this test')
      },
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
    expect(textContent).toContain('```notes/explicit.md\n1|# Explicit\n2|Body\n```')
    expect(textContent).toContain('```notes/current.md\n1|# Current\n2|More\n```')
    expect(textContent).toContain('## Mentioned Vault Folders\n- `docs`')
    expect(textContent).toContain('- `docs/from-folder.md`\n  - L1 ## Folder Heading')
    expect(textContent).not.toContain('Folder body')
  })
})
