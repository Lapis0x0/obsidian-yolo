import type { App } from 'obsidian'

import {
  findActiveWebviewHandle,
  readActiveWebviewSnapshot,
} from '../../../core/browser/activeWebviewProbe'

import { renderBrowserContextInjection } from './browserContext'

jest.mock('../../../core/browser/activeWebviewProbe', () => ({
  findActiveWebviewHandle: jest.fn(),
  readActiveWebviewSnapshot: jest.fn(),
}))

const mockedFindActiveWebviewHandle =
  findActiveWebviewHandle as jest.MockedFunction<typeof findActiveWebviewHandle>
const mockedReadActiveWebviewSnapshot =
  readActiveWebviewSnapshot as jest.MockedFunction<
    typeof readActiveWebviewSnapshot
  >

describe('renderBrowserContextInjection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns null when no active webview handle exists', async () => {
    mockedFindActiveWebviewHandle.mockReturnValue(null)

    const result = await renderBrowserContextInjection({
      type: 'browser-context',
      app: {} as App,
    })

    expect(result).toBeNull()
    expect(mockedReadActiveWebviewSnapshot).not.toHaveBeenCalled()
  })

  it('returns null when the snapshot is unavailable', async () => {
    mockedFindActiveWebviewHandle.mockReturnValue({
      pageId: 'page_ab12cd34_ef56gh78',
    } as never)
    mockedReadActiveWebviewSnapshot.mockResolvedValue(null)

    const result = await renderBrowserContextInjection({
      type: 'browser-context',
      app: {} as App,
    })

    expect(result).toBeNull()
  })

  it('renders the slim browser_context payload with scroll metadata', async () => {
    mockedFindActiveWebviewHandle.mockReturnValue({
      pageId: 'page_ab12cd34_ef56gh78',
    } as never)
    mockedReadActiveWebviewSnapshot.mockResolvedValue({
      pageId: 'page_ab12cd34_ef56gh78',
      url: 'https://example.com/article',
      title: 'Example Article',
      meta: {
        scrollY: 800,
        viewportHeight: 700,
        documentHeight: 5000,
      },
    } as never)

    const result = await renderBrowserContextInjection({
      type: 'browser-context',
      app: {} as App,
    })

    expect(result).toEqual({
      role: 'user',
      content: [
        '<browser_context>',
        '  <active_page>',
        '    <page_id>page_ab12cd34_ef56gh78</page_id>',
        '    <url>https://example.com/article</url>',
        '    <title>Example Article</title>',
        '    <document_height_px>5000</document_height_px>',
        '    <viewport_height_px>700</viewport_height_px>',
        '    <scroll_y_px>800</scroll_y_px>',
        '  </active_page>',
        '</browser_context>',
      ].join('\n'),
    })
  })

  it('omits scroll metadata when page meta is unavailable', async () => {
    mockedFindActiveWebviewHandle.mockReturnValue({
      pageId: 'page_ab12cd34_ef56gh78',
    } as never)
    mockedReadActiveWebviewSnapshot.mockResolvedValue({
      pageId: 'page_ab12cd34_ef56gh78',
      url: 'https://example.com/pending',
      title: 'Pending',
      loading: true,
    } as never)

    const result = await renderBrowserContextInjection({
      type: 'browser-context',
      app: {} as App,
    })

    expect(result?.content).toBe(
      [
        '<browser_context>',
        '  <active_page>',
        '    <page_id>page_ab12cd34_ef56gh78</page_id>',
        '    <url>https://example.com/pending</url>',
        '    <title>Pending</title>',
        '  </active_page>',
        '</browser_context>',
      ].join('\n'),
    )
    expect(result?.content).not.toContain('<source>')
    expect(result?.content).not.toContain('<loading>')
    expect(result?.content).not.toContain('visible_text_chars')
  })
})
