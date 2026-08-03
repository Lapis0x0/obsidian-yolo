import { type App, TFile } from 'obsidian'

import { parseYoloSettings } from '../../settings/schema/settings'
import {
  renderBrowserContextInjection,
  renderCurrentFilePointerInjection,
} from '../../utils/chat/contextual-injections'

import { buildCliEnvironmentContext } from './environment-context'

jest.mock('../../utils/chat/contextual-injections', () => ({
  renderBrowserContextInjection: jest.fn(),
  renderCurrentFilePointerInjection: jest.fn(),
}))

const mockedRenderCurrentFilePointerInjection =
  renderCurrentFilePointerInjection as jest.MockedFunction<
    typeof renderCurrentFilePointerInjection
  >
const mockedRenderBrowserContextInjection =
  renderBrowserContextInjection as jest.MockedFunction<
    typeof renderBrowserContextInjection
  >

describe('buildCliEnvironmentContext', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('captures the current file position and browser state together', async () => {
    mockedRenderCurrentFilePointerInjection.mockResolvedValue({
      role: 'user',
      content: '# Current Context\nFile: Notes/plan.md\nCursor: line 42',
    })
    mockedRenderBrowserContextInjection.mockResolvedValue({
      role: 'user',
      content: '<browser_context>page</browser_context>',
    })
    const settings = parseYoloSettings({})
    const app = {} as App
    const currentFile = Object.assign(new TFile(), {
      path: 'Notes/plan.md',
    })

    await expect(
      buildCliEnvironmentContext({
        app,
        settings,
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
      { app, settings },
    )
    expect(mockedRenderBrowserContextInjection).toHaveBeenCalledWith({
      type: 'browser-context',
      app,
    })
  })
})
