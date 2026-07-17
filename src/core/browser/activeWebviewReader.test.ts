import type { ActiveWebviewHandle, WebviewLike } from './activeWebviewProbe'
import {
  BrowserReadFailure,
  readActiveWebviewHtml,
  readActiveWebviewPage,
} from './activeWebviewReader'

const buildHandle = (webview: Partial<WebviewLike>): ActiveWebviewHandle => ({
  pageId: 'page_abcdefgh_1234abcd',
  leaf: {} as ActiveWebviewHandle['leaf'],
  webview: {
    getURL: () => 'https://example.com/article',
    getTitle: () => 'Example',
    executeJavaScript: () => Promise.resolve(''),
    ...webview,
  } as WebviewLike,
  viewType: 'webviewer',
  source: 'core_webviewer',
  userFocused: true,
})

describe('readActiveWebviewPage', () => {
  it('returns already rendered content when URL is not ready yet', async () => {
    const handle = buildHandle({
      getURL: () => '',
      executeJavaScript: () =>
        Promise.resolve({
          kind: 'readable',
          url: '',
          title: 'Partial',
          html: '<p>Partial body</p>',
          headings: [],
          links: [],
          counts: { password: 0, hidden_input: 0, file_input: 0 },
        }),
    })
    const result = await readActiveWebviewPage(handle, {
      format: 'readable',
    })
    expect(result?.title).toBe('Partial')
    expect(result?.text).toBe('<p>Partial body</p>')
    expect(result?.loading).toBe(false)
  })

  it('returns null for an empty about:blank page', async () => {
    const handle = buildHandle({
      getURL: () => 'about:blank',
      executeJavaScript: () =>
        Promise.resolve({
          kind: 'readable',
          url: 'about:blank',
          title: '',
          html: '',
          headings: [],
          links: [],
          counts: { password: 0, hidden_input: 0, file_input: 0 },
        }),
    })
    const result = await readActiveWebviewPage(handle, {
      format: 'readable',
    })
    expect(result).toBeNull()
  })

  it('returns markdown text in readable format', async () => {
    const handle = buildHandle({
      executeJavaScript: () =>
        Promise.resolve({
          kind: 'readable',
          url: 'https://example.com/article',
          title: 'Article',
          html: '<h1>Hi</h1><p>Body text</p>',
          headings: [{ level: 1, text: 'Hi' }],
          links: [],
          counts: { password: 0, hidden_input: 0, file_input: 0 },
        }),
    })
    const result = await readActiveWebviewPage(handle, {
      format: 'readable',
    })
    expect(result).not.toBeNull()
    expect(result?.text).toBe('<h1>Hi</h1><p>Body text</p>') // mocked htmlToMarkdown is identity
    expect(result?.source).toBe('core_webviewer')
    expect(result?.headings).toEqual([{ level: 1, text: 'Hi' }])
    expect(result?.redactions).toEqual([])
  })

  it('returns compact key visible information including formulas', async () => {
    const executeJavaScript = jest.fn(() =>
      Promise.resolve({
        kind: 'key_visible_info',
        url: 'https://example.com',
        title: 'X',
        keyInfo: '## Main result\nFormula: E = mc^2\n- Important point',
        counts: { password: 0, hidden_input: 0, file_input: 0 },
      }),
    )
    const handle = buildHandle({
      executeJavaScript,
    })
    const result = await readActiveWebviewPage(handle, {
      format: 'key_visible_info',
    })
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('"key_visible_info"'),
    )
    expect(result?.text).toContain('Formula: E = mc^2')
    expect(result?.text).toContain('Important point')
    expect(result?.headings).toBeUndefined()
    expect(result?.links).toBeUndefined()
  })

  it('returns full text without internal truncation', async () => {
    const html = 'a'.repeat(1000)
    const handle = buildHandle({
      executeJavaScript: () =>
        Promise.resolve({
          kind: 'readable',
          url: 'https://example.com',
          title: 'X',
          html,
          headings: [],
          links: [],
          counts: { password: 0, hidden_input: 0, file_input: 0 },
        }),
    })
    const result = await readActiveWebviewPage(handle, {
      format: 'readable',
    })
    expect(result?.text?.length).toBe(1000)
  })

  it('surfaces redaction counts', async () => {
    const handle = buildHandle({
      executeJavaScript: () =>
        Promise.resolve({
          kind: 'readable',
          url: 'https://example.com',
          title: 'X',
          html: '',
          headings: [],
          links: [],
          counts: { password: 1, hidden_input: 3, file_input: 0 },
        }),
    })
    const result = await readActiveWebviewPage(handle, {
      format: 'readable',
    })
    expect(result?.redactions).toEqual([
      { kind: 'password', count: 1 },
      { kind: 'hidden_input', count: 3 },
    ])
  })

  it('wraps extraction errors in BrowserReadFailure', async () => {
    const handle = buildHandle({
      executeJavaScript: () => Promise.reject(new Error('boom')),
    })
    await expect(
      readActiveWebviewPage(handle, {
        format: 'readable',
      }),
    ).rejects.toBeInstanceOf(BrowserReadFailure)
  })

  it('flags timeout via BrowserReadFailure code=extraction_timeout', async () => {
    const handle = buildHandle({
      executeJavaScript: () => new Promise(() => undefined),
    })
    await expect(
      readActiveWebviewPage(handle, {
        format: 'readable',
        executionTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ code: 'extraction_timeout' })
  })

  it('returns partial success instead of timing out while the page is loading', async () => {
    const handle = buildHandle({
      getURL: () => 'https://example.com/loading',
      getTitle: () => 'Loading',
      isLoading: () => true,
      executeJavaScript: () => new Promise(() => undefined),
    })
    const result = await readActiveWebviewPage(handle, {
      format: 'key_visible_info',
      executionTimeoutMs: 20,
    })
    expect(result).toMatchObject({
      url: 'https://example.com/loading',
      title: 'Loading',
      loading: true,
      text: '',
      headings: [],
      links: [],
      partial: { reason: 'page_loading' },
      redactions: [],
    })
  })

  it('rejects malformed extraction payloads', async () => {
    const handle = buildHandle({
      executeJavaScript: () => Promise.resolve({ url: 1, title: 2 }),
    })
    await expect(
      readActiveWebviewPage(handle, {
        format: 'readable',
      }),
    ).rejects.toMatchObject({ code: 'extraction_failed' })
  })
})

describe('readActiveWebviewHtml', () => {
  it('returns full rendered DOM HTML with basic page metadata', async () => {
    const executeJavaScript = jest.fn(() =>
      Promise.resolve({
        kind: 'html',
        url: 'https://example.com/article',
        title: 'Article',
        html: '<html><body><main>Body</main></body></html>',
        byteLength: 42,
      }),
    )
    const handle = buildHandle({ executeJavaScript })

    const result = await readActiveWebviewHtml(handle, { maxBytes: 1024 })

    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('1024'),
    )
    expect(result).toEqual(
      expect.objectContaining({
        url: 'https://example.com/article',
        title: 'Article',
        html: '<html><body><main>Body</main></body></html>',
        byteLength: 42,
      }),
    )
  })

  it('returns null for an empty about:blank page', async () => {
    const handle = buildHandle({
      executeJavaScript: () =>
        Promise.resolve({
          kind: 'html',
          url: 'about:blank',
          title: '',
          html: '',
          byteLength: 0,
        }),
    })

    await expect(readActiveWebviewHtml(handle)).resolves.toBeNull()
  })

  it('refuses oversized HTML reported by the webview script', async () => {
    const handle = buildHandle({
      executeJavaScript: () =>
        Promise.resolve({
          kind: 'html_too_large',
          url: 'https://example.com/article',
          title: 'Article',
          byteLength: 2048,
          maxBytes: 1024,
        }),
    })

    await expect(
      readActiveWebviewHtml(handle, { maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'content_too_large' })
  })

  it('rejects malformed HTML extraction payloads', async () => {
    const handle = buildHandle({
      executeJavaScript: () => Promise.resolve({ kind: 'html', html: 1 }),
    })

    await expect(readActiveWebviewHtml(handle)).rejects.toMatchObject({
      code: 'extraction_failed',
    })
  })
})
