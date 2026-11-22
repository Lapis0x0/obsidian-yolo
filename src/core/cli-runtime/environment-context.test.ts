import { type App, TFile } from 'obsidian'

import {
  renderBrowserContextInjection,
  renderCurrentFilePointerInjection,
  renderInjectedContext,
} from '../../utils/chat/contextual-injections'

import {
  buildCliEnvironmentContext,
  isFirstCliTurn,
  renderCliProjectContext,
} from './environment-context'

jest.mock('../../utils/chat/contextual-injections', () => ({
  renderBrowserContextInjection: jest.fn(),
  renderCurrentFilePointerInjection: jest.fn(),
  renderInjectedContext: jest.fn(),
}))

const mockedRenderCurrentFilePointerInjection =
  renderCurrentFilePointerInjection as jest.MockedFunction<
    typeof renderCurrentFilePointerInjection
  >
const mockedRenderBrowserContextInjection =
  renderBrowserContextInjection as jest.MockedFunction<
    typeof renderBrowserContextInjection
  >
const mockedRenderInjectedContext =
  renderInjectedContext as jest.MockedFunction<typeof renderInjectedContext>

describe('buildCliEnvironmentContext', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('captures the current file position and browser state together', async () => {
    const filePart = {
      type: 'text' as const,
      text: '# Current Context\nFile: Notes/plan.md\nCursor: line 42',
    }
    const browserPart = {
      type: 'text' as const,
      text: '<browser_context>page</browser_context>',
    }
    mockedRenderCurrentFilePointerInjection.mockReturnValue([filePart])
    mockedRenderBrowserContextInjection.mockResolvedValue([browserPart])
    mockedRenderInjectedContext.mockImplementation((parts) =>
      Promise.resolve(
        parts.flatMap((part) =>
          part.type === 'text'
            ? [{ type: 'text' as const, text: part.text }]
            : [],
        ),
      ),
    )
    const app = {} as App
    const currentFile = Object.assign(new TFile(), {
      path: 'Notes/plan.md',
    })

    await expect(
      buildCliEnvironmentContext({
        app,
        runtimeId: 'hermes',
        currentFile,
        currentFileViewState: {
          kind: 'markdown-edit',
          visibleStartLine: 30,
          visibleEndLine: 60,
          cursorLine: 42,
          totalLines: 100,
        },
      }),
    ).resolves.toEqual([
      {
        type: 'text',
        text: '# Current Context\nFile: Notes/plan.md\nCursor: line 42',
      },
      { type: 'text', text: '<browser_context>page</browser_context>' },
    ])

    expect(mockedRenderCurrentFilePointerInjection).toHaveBeenCalledWith(
      expect.objectContaining({
        file: currentFile,
        viewState: expect.objectContaining({ cursorLine: 42 }),
      }),
    )
    expect(mockedRenderInjectedContext).toHaveBeenCalledWith(
      [filePart, browserPart],
      app,
    )
    expect(mockedRenderBrowserContextInjection).toHaveBeenCalledWith({
      type: 'browser-context',
      app,
    })
  })

  it('drops the auto-attached image for a runtime that takes no image input', async () => {
    mockedRenderCurrentFilePointerInjection.mockReturnValue([])
    mockedRenderBrowserContextInjection.mockResolvedValue(null)
    mockedRenderInjectedContext.mockResolvedValue([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      { type: 'text', text: '# Current Context\nFile: Notes/diagram.png' },
    ])
    const currentFile = Object.assign(new TFile(), {
      path: 'Notes/diagram.png',
    })

    await expect(
      buildCliEnvironmentContext({
        app: {} as App,
        runtimeId: 'grok',
        currentFile,
      }),
    ).resolves.toEqual([
      { type: 'text', text: '# Current Context\nFile: Notes/diagram.png' },
    ])
  })
})

describe('renderCliProjectContext', () => {
  const project = {
    id: 'p1',
    name: 'Thesis',
    workspaceScope: {
      enabled: true,
      include: ['School'],
      exclude: ['School/old'],
    },
    createdAt: 0,
    updatedAt: 0,
  }
  const appWithFiles = (paths: string[]) =>
    ({
      vault: {
        getFileByPath: (path: string) => (paths.includes(path) ? {} : null),
        getFolderByPath: (path: string) =>
          path === 'School' || path === '' ? { path, children: [] } : null,
        getRoot: () => ({ path: '/', children: [] }),
        getAbstractFileByPath: () => null,
      },
    }) as unknown as App

  it('names the project and its focus folders as guidance', () => {
    const text = renderCliProjectContext({
      app: appWithFiles([]),
      project,
      settings: { projects: [project] },
    })
    expect(text).toContain('YOLO project "Thesis"')
    expect(text).toContain('- Focus folders: School.')
    expect(text).toContain('- Leave alone: School/old.')
    expect(text).not.toContain('Project memory')
  })

  it('points at the project memory index once it exists', () => {
    const text = renderCliProjectContext({
      app: appWithFiles(['YOLO/memory/projects/Thesis/MEMORY.md']),
      project,
      settings: { projects: [project] },
    })
    expect(text).toContain(
      '- Project memory index: YOLO/memory/projects/Thesis/MEMORY.md.',
    )
  })
})

describe('isFirstCliTurn', () => {
  const messages = [
    { role: 'user', id: 'u1' },
    { role: 'assistant', id: 'a1' },
    { role: 'user', id: 'u2' },
  ]

  it('is the first turn only before any user message exists', () => {
    expect(isFirstCliTurn([])).toBe(true)
    expect(isFirstCliTurn(messages)).toBe(false)
  })

  it('treats rewriting the first user message as the first turn again', () => {
    expect(isFirstCliTurn(messages, 'u1')).toBe(true)
    expect(isFirstCliTurn(messages, 'u2')).toBe(false)
  })
})
