import type { App, WorkspaceLeaf } from 'obsidian'

import { CHAT_VIEW_TYPE } from '../../constants'

import {
  type ActiveWebviewHandle,
  type WebviewLike,
  findActiveWebviewHandle,
  findWebviewHandleByPageId,
  noteWebviewLeafFocus,
  readActiveWebviewSnapshot,
} from './activeWebviewProbe'

// Minimal element stub providing only the API findActiveWebviewHandle relies on.
type ContainerEl = {
  querySelector: (selector: string) => unknown
}

const buildLeaf = (viewType: string, webview: Partial<WebviewLike> | null) => {
  const containerEl: ContainerEl = {
    querySelector: (selector: string) =>
      selector === 'webview' ? webview : null,
  }
  return {
    view: {
      getViewType: () => viewType,
      containerEl,
    },
  }
}

const buildFakeApp = (
  viewType: string | null,
  webview: Partial<WebviewLike> | null,
): App => {
  if (viewType === null) {
    return {
      workspace: {
        rootSplit: {},
        getMostRecentLeaf: () => null,
        iterateAllLeaves: () => undefined,
      },
    } as unknown as App
  }
  const leaf = buildLeaf(viewType, webview)
  return {
    workspace: {
      rootSplit: {},
      getMostRecentLeaf: () => leaf,
      iterateAllLeaves: () => undefined,
    },
  } as unknown as App
}

const stubWebview = (
  overrides: Partial<WebviewLike> = {},
): Partial<WebviewLike> => ({
  getURL: () => 'https://example.com/page',
  getTitle: () => 'Example',
  executeJavaScript: () => Promise.resolve(''),
  ...overrides,
})

describe('findActiveWebviewHandle', () => {
  it('returns null when there is no active leaf', () => {
    expect(findActiveWebviewHandle(buildFakeApp(null, null))).toBeNull()
  })

  it('returns null when viewType is not in the allowlist', () => {
    expect(
      findActiveWebviewHandle(buildFakeApp('surfing-view', stubWebview())),
    ).toBeNull()
  })

  it('returns null when no <webview> element exists', () => {
    expect(findActiveWebviewHandle(buildFakeApp('webviewer', null))).toBeNull()
  })

  it('returns null when the <webview> element is missing required methods', () => {
    expect(
      findActiveWebviewHandle(buildFakeApp('webviewer', { getURL: () => 'x' })),
    ).toBeNull()
  })

  it('maps viewType=webviewer → source=core_webviewer', () => {
    const handle = findActiveWebviewHandle(
      buildFakeApp('webviewer', stubWebview()),
    )
    expect(handle).not.toBeNull()
    expect(handle?.pageId).toMatch(/^page_[a-z0-9]{8}_[a-z0-9]{8}$/)
    expect(handle?.source).toBe('core_webviewer')
    expect(handle?.viewType).toBe('webviewer')
    expect(handle?.userFocused).toBe(true)
  })

  it('maps viewType=url-webview → source=url_webview_opener', () => {
    const handle = findActiveWebviewHandle(
      buildFakeApp('url-webview', stubWebview()),
    )
    expect(handle).not.toBeNull()
    expect(handle?.pageId).toMatch(/^page_[a-z0-9]{8}_[a-z0-9]{8}$/)
    expect(handle?.source).toBe('url_webview_opener')
    expect(handle?.viewType).toBe('url-webview')
  })

  it('returns null when the most recent leaf is not a supported webview', () => {
    const app = {
      workspace: {
        rootSplit: {},
        getMostRecentLeaf: () => buildLeaf('markdown', null),
      },
    } as unknown as App
    expect(findActiveWebviewHandle(app)).toBeNull()
  })

  it('falls back to the last focused webview when Chat has focus', () => {
    const webviewLeaf = buildLeaf('webviewer', stubWebview())
    const chatLeaf = buildLeaf(CHAT_VIEW_TYPE, null)
    const app = {
      workspace: {
        rootSplit: {},
        getMostRecentLeaf: () => chatLeaf,
        iterateAllLeaves: () => undefined,
      },
    } as unknown as App

    noteWebviewLeafFocus(app, webviewLeaf as unknown as WorkspaceLeaf)
    const handle = findActiveWebviewHandle(app)

    expect(handle?.leaf).toBe(webviewLeaf)
    expect(handle?.userFocused).toBe(false)
  })

  it('does not fall back to a stale webview when a non-chat leaf has focus', () => {
    const webviewLeaf = buildLeaf('webviewer', stubWebview())
    const markdownLeaf = buildLeaf('markdown', null)
    const app = {
      workspace: {
        rootSplit: {},
        getMostRecentLeaf: () => markdownLeaf,
        iterateAllLeaves: () => undefined,
      },
    } as unknown as App

    noteWebviewLeafFocus(app, webviewLeaf as unknown as WorkspaceLeaf)

    expect(findActiveWebviewHandle(app)).toBeNull()
  })

  it('finds a specific open webview by opaque page id, not URL', () => {
    const first = buildLeaf(
      'webviewer',
      stubWebview({
        getURL: () => 'https://example.com/same',
        getTitle: () => 'First',
      }),
    )
    const second = buildLeaf(
      'webviewer',
      stubWebview({
        getURL: () => 'https://example.com/same',
        getTitle: () => 'Second',
      }),
    )
    const app = {
      workspace: {
        rootSplit: {},
        getMostRecentLeaf: () => first,
        iterateAllLeaves: (callback: (leaf: unknown) => void) => {
          callback(first)
          callback(second)
        },
      },
    } as unknown as App
    const secondHandle = findActiveWebviewHandle({
      workspace: {
        rootSplit: {},
        getMostRecentLeaf: () => second,
      },
    } as unknown as App)

    expect(secondHandle).not.toBeNull()
    const found = findWebviewHandleByPageId(app, secondHandle?.pageId ?? '')
    expect(found?.leaf).toBe(second)
    expect(found?.webview.getTitle()).toBe('Second')
  })
})

const buildHandle = (webview: Partial<WebviewLike>): ActiveWebviewHandle => {
  const handle = findActiveWebviewHandle(buildFakeApp('webviewer', webview))
  if (!handle) throw new Error('handle should exist for test fixture')
  return handle
}

describe('readActiveWebviewSnapshot', () => {
  it('returns null when URL is empty (page not yet loaded)', async () => {
    const handle = buildHandle({
      getURL: () => '',
      getTitle: () => '',
      executeJavaScript: () => Promise.resolve(''),
    })
    expect(
      await readActiveWebviewSnapshot(handle, { maxSelectionChars: 2000 }),
    ).toBeNull()
  })

  it('returns null for about:blank', async () => {
    const handle = buildHandle({
      getURL: () => 'about:blank',
      getTitle: () => '',
      executeJavaScript: () => Promise.resolve(''),
    })
    expect(
      await readActiveWebviewSnapshot(handle, { maxSelectionChars: 2000 }),
    ).toBeNull()
  })

  it('returns snapshot with URL/title and omits selection when empty', async () => {
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Example Article',
      executeJavaScript: () => Promise.resolve(''),
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 2000,
    })
    expect(snapshot).toEqual({
      pageId: handle.pageId,
      source: 'core_webviewer',
      viewType: 'webviewer',
      url: 'https://example.com/article',
      title: 'Example Article',
      loading: false,
      userFocused: true,
      meta: undefined,
      selection: undefined,
      selectionTruncated: undefined,
    })
  })

  it('includes scroll and viewport metadata when available', async () => {
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Example Article',
      executeJavaScript: (code) => {
        if (code.includes('documentHeight')) {
          return Promise.resolve({
            scrollY: 800,
            viewportHeight: 700,
            documentHeight: 5000,
          })
        }
        return Promise.resolve('selected')
      },
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 2000,
    })
    expect(snapshot?.meta).toEqual({
      scrollY: 800,
      viewportHeight: 700,
      documentHeight: 5000,
    })
    expect(snapshot?.selection).toBe('selected')
  })

  it('reports loading state and skips page scripts while loading', async () => {
    const exec = jest.fn(() => Promise.resolve('selected'))
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Loading Article',
      isLoading: () => true,
      executeJavaScript: exec,
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 2000,
    })
    expect(snapshot).toEqual({
      pageId: handle.pageId,
      source: 'core_webviewer',
      viewType: 'webviewer',
      url: 'https://example.com/article',
      title: 'Loading Article',
      loading: true,
      userFocused: true,
    })
    expect(exec).not.toHaveBeenCalled()
  })

  it('treats either webview loading API as loading', async () => {
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Loading Article',
      isLoadingMainFrame: () => false,
      isLoading: () => true,
      executeJavaScript: jest.fn(() => Promise.resolve('selected')),
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 2000,
    })
    expect(snapshot?.loading).toBe(true)
    expect(snapshot?.selection).toBeUndefined()
  })

  it('includes trimmed non-empty selection', async () => {
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Example',
      executeJavaScript: () => Promise.resolve('  highlighted phrase  '),
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 2000,
    })
    expect(snapshot?.selection).toBe('highlighted phrase')
    expect(snapshot?.selectionTruncated).toBe(false)
  })

  it('truncates selection longer than maxSelectionChars and tags as truncated', async () => {
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Example',
      executeJavaScript: () => Promise.resolve('a'.repeat(50)),
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 20,
    })
    expect(snapshot?.selection).toMatch(/\.\.\.\(truncated\)$/)
    expect(snapshot?.selection?.length).toBeLessThanOrEqual(20)
    expect(snapshot?.selectionTruncated).toBe(true)
  })

  it('skips selection when maxSelectionChars is 0 but still reads scroll metadata', async () => {
    const exec = jest.fn((_code?: string) => Promise.resolve('something'))
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Example',
      executeJavaScript: exec,
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 0,
    })
    expect(snapshot?.selection).toBeUndefined()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec.mock.calls[0]?.[0]).toContain('documentHeight')
  })

  it('omits selection when executeJavaScript exceeds the timeout', async () => {
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Example',
      executeJavaScript: () => new Promise(() => undefined),
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 2000,
      selectionTimeoutMs: 20,
    })
    expect(snapshot?.url).toBe('https://example.com/article')
    expect(snapshot?.selection).toBeUndefined()
  })

  it('omits selection when executeJavaScript rejects (cross-origin, page closed, etc.)', async () => {
    const handle = buildHandle({
      getURL: () => 'https://example.com/article',
      getTitle: () => 'Example',
      executeJavaScript: () => Promise.reject(new Error('cross-origin')),
    })
    const snapshot = await readActiveWebviewSnapshot(handle, {
      maxSelectionChars: 2000,
    })
    expect(snapshot?.selection).toBeUndefined()
  })
})
