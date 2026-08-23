jest.mock('obsidian')

jest.mock('../agent/subagent/runner', () => ({
  runSubagent: jest.fn().mockResolvedValue({
    accepted: true,
    taskId: 'sub_test',
    title: 'Test',
    status: 'running',
    note: 'accepted',
    modelName: 'mock',
  }),
}))

jest.mock('../browser/activeWebviewProbe', () => ({
  BROWSER_PAGE_ID_PATTERN: /^page_[a-z0-9]{8}_[a-z0-9]{8}$/,
  findWebviewHandleByPageId: jest.fn(),
}))

jest.mock('../browser/activeWebviewReader', () => ({
  BrowserReadFailure: class BrowserReadFailure extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
      this.name = 'BrowserReadFailure'
    }
  },
  readActiveWebviewHtml: jest.fn(),
}))

import { App, TFile, TFolder } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'
import {
  getPendingDangerousBashApproval,
  resolveDangerousBashApproval,
} from '../agent/bash/dangerousOperationGate'
import { runSubagent } from '../agent/subagent/runner'
import { findWebviewHandleByPageId } from '../browser/activeWebviewProbe'
import { readActiveWebviewHtml } from '../browser/activeWebviewReader'
import type {
  RuntimeComponentId,
  RuntimeComponentLease,
} from '../runtime-components/contracts'
import { setRuntimeComponentAcquirerForTests } from '../runtime-components/runtimeComponentAccess'
import { executeBuiltinTool } from '../tools/dispatcher'
import type { LocalToolCallResult, ToolContext } from '../tools/types'

import { buildJsSandboxToolDescription } from './jsSandboxSettings'
import {
  JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB,
  JS_SANDBOX_DB_QUERY_DEFAULT_MAX_LIMIT,
  JS_SANDBOX_VAULT_LIST_MAX_ENTRIES,
  buildJsSandboxProxyHandlers,
  formatJsSandboxToolText,
} from './jsSandboxTool'
import {
  getLocalFileTools,
  isLocalFsWriteToolName,
  parseLocalFsActionFromToolArgs,
  recoverLikelyEscapedBackslashSequences,
} from './localFileTools'

/**
 * The old `callLocalFileTool` switch was deleted once every built-in tool
 * lived in the registry (docs/plans/2026-08-15-tool-registry, D12). These
 * suites are the original behavioural coverage for those tools, so they
 * stay — re-pointed at the one remaining execution path. The adapter keeps
 * their call shape unchanged so the re-point is visibly a boundary swap and
 * nothing else.
 */
const callLocalFileTool = ({
  toolName,
  args,
  ...context
}: ToolContext & {
  toolName: string
  args: Record<string, unknown>
}): Promise<LocalToolCallResult> =>
  executeBuiltinTool(toolName, args, {
    // `delegate_subagent` used to import `runner.ts` itself; it now receives
    // it through `ToolContext` (mcpManager.ts does the same injection in
    // production). Defaulted here so the suites below keep asserting against
    // the module mock at the top of this file, and still overridable per call.
    runSubagent: runSubagent as unknown as ToolContext['runSubagent'],
    ...context,
  })

afterEach(() => {
  editUndoSnapshotStore.clear()
  ;(runSubagent as jest.Mock).mockClear()
  setRuntimeComponentAcquirerForTests(null)
})

describe('recoverLikelyEscapedBackslashSequences', () => {
  it('recovers latex commands decoded as control characters', () => {
    const broken = `A=${'\b'}egin{bmatrix}1 & 2${'\t'}imes y`
    const recovered = recoverLikelyEscapedBackslashSequences(broken)

    expect(recovered).toContain('\\begin{bmatrix}')
    expect(recovered).toContain('\\times y')
  })

  it('keeps intended newline and tab characters unchanged when not command-like', () => {
    const input = 'line1\n\nline2\t42'
    const recovered = recoverLikelyEscapedBackslashSequences(input)

    expect(recovered).toBe(input)
  })
})

describe('js sandbox vault list handler', () => {
  const basename = (path: string) => path.split('/').pop() ?? path

  const makeFile = (path: string, size = 10, mtime = 1000): TFile =>
    Object.assign(new TFile(), {
      path,
      name: basename(path),
      stat: { size, mtime },
    })

  const makeFolder = (
    path: string,
    children: Array<TFile | TFolder> = [],
  ): TFolder =>
    Object.assign(new TFolder(), {
      path,
      name: path ? basename(path) : '',
      children,
    })

  const makeApp = (root: TFolder, entries: Array<TFile | TFolder>): App => {
    const byPath = new Map(entries.map((entry) => [entry.path, entry]))
    return {
      vault: {
        getRoot: jest.fn().mockReturnValue(root),
        getAbstractFileByPath: jest
          .fn()
          .mockImplementation((path: string) => byPath.get(path) ?? null),
        cachedRead: jest
          .fn()
          .mockImplementation((file: TFile) => `content:${file.path}`),
      },
    } as unknown as App
  }

  const getVaultList = (app: App) => {
    const handlers = buildJsSandboxProxyHandlers(app, {
      allowVaultRead: true,
    })
    if (!handlers.vaultList) {
      throw new Error('expected vaultList handler')
    }
    return handlers.vaultList
  }

  it('lists direct child dirs and files by default', async () => {
    const nested = makeFile('a/nested.md', 20, 2000)
    const folder = makeFolder('a', [nested])
    const file = makeFile('b.md', 30, 3000)
    const root = makeFolder('', [file, folder])
    const list = getVaultList(makeApp(root, [folder, nested, file]))

    await expect(list()).resolves.toEqual([
      { kind: 'dir', path: 'a', name: 'a' },
      {
        kind: 'file',
        path: 'b.md',
        name: 'b.md',
        size: 30,
        mtime: 3000,
      },
    ])
  })

  it('lists the whole subtree when recursive is true', async () => {
    const nested = makeFile('a/nested.md', 20, 2000)
    const folder = makeFolder('a', [nested])
    const file = makeFile('b.md', 30, 3000)
    const root = makeFolder('', [file, folder])
    const list = getVaultList(makeApp(root, [folder, nested, file]))

    await expect(list('/', { recursive: true })).resolves.toEqual([
      { kind: 'dir', path: 'a', name: 'a' },
      {
        kind: 'file',
        path: 'a/nested.md',
        name: 'nested.md',
        size: 20,
        mtime: 2000,
      },
      {
        kind: 'file',
        path: 'b.md',
        name: 'b.md',
        size: 30,
        mtime: 3000,
      },
    ])
  })

  it('rejects missing folders, file targets, and invalid paths', async () => {
    const file = makeFile('b.md')
    const root = makeFolder('', [file])
    const list = getVaultList(makeApp(root, [file]))

    await expect(list('missing')).rejects.toThrow('Folder not found: missing')
    await expect(list('b.md')).rejects.toThrow('Path is not a folder: b.md')
    await expect(list('../outside')).rejects.toThrow(
      'Path must be a vault-relative path.',
    )
  })

  it('refuses pathological vault lists above the hard entry cap', async () => {
    const files = Array.from(
      { length: JS_SANDBOX_VAULT_LIST_MAX_ENTRIES + 1 },
      (_, index) => makeFile(`f-${index}.md`),
    )
    const root = makeFolder('', files)
    const list = getVaultList(makeApp(root, files))

    await expect(list()).rejects.toThrow(
      `more than ${JS_SANDBOX_VAULT_LIST_MAX_ENTRIES} entries`,
    )
  })

  it('does not expose the handler when vault read is disabled', () => {
    const root = makeFolder('')
    const handlers = buildJsSandboxProxyHandlers(makeApp(root, []), {})

    expect(handlers.vaultList).toBeUndefined()
    expect(handlers.vaultReadText).toBeUndefined()
    expect(handlers.vaultReadBinary).toBeUndefined()
  })

  it('exposes only known-path text reads when db query is enabled', async () => {
    const file = makeFile('notes/a.md')
    const root = makeFolder('', [file])
    const handlers = buildJsSandboxProxyHandlers(makeApp(root, [file]), {
      allowDbQuery: true,
    })

    expect(handlers.vaultList).toBeUndefined()
    expect(handlers.vaultReadBinary).toBeUndefined()
    if (!handlers.vaultReadText) {
      throw new Error('expected vaultReadText handler')
    }
    await expect(handlers.vaultReadText('notes/a.md')).resolves.toBe(
      'content:notes/a.md',
    )
  })

  describe('YOLO user data root exclusion', () => {
    const settings = { yolo: { baseDir: 'YOLO' } } as unknown as YoloSettings

    it('excludes the user data root from vault.list', async () => {
      const chatFile = makeFile('YOLO/data/chats/v1_abc.json')
      const dataFolder = makeFolder('YOLO/data', [chatFile])
      const noteFile = makeFile('Notes/a.md')
      const yoloFolder = makeFolder('YOLO', [dataFolder])
      const root = makeFolder('', [yoloFolder, noteFile])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [yoloFolder, dataFolder, chatFile, noteFile]),
        { allowVaultRead: true },
        undefined,
        settings,
      )
      if (!handlers.vaultList) throw new Error('expected vaultList handler')

      await expect(
        handlers.vaultList('/', { recursive: true }),
      ).resolves.toEqual([
        {
          kind: 'file',
          path: 'Notes/a.md',
          name: 'a.md',
          size: 10,
          mtime: 1000,
        },
        { kind: 'dir', path: 'YOLO', name: 'YOLO' },
      ])
    })

    it('reports the user data root itself as a missing folder for vault.list', async () => {
      const dataFolder = makeFolder('YOLO/data')
      const yoloFolder = makeFolder('YOLO', [dataFolder])
      const root = makeFolder('', [yoloFolder])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [yoloFolder, dataFolder]),
        { allowVaultRead: true },
        undefined,
        settings,
      )
      if (!handlers.vaultList) throw new Error('expected vaultList handler')

      await expect(handlers.vaultList('YOLO/data')).rejects.toThrow(
        'Folder not found: YOLO/data',
      )
    })

    it('reports null (not found) for vault.readText under the user data root', async () => {
      const chatFile = makeFile('YOLO/data/chats/v1_abc.json')
      const root = makeFolder('', [chatFile])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [chatFile]),
        { allowVaultRead: true },
        undefined,
        settings,
      )
      if (!handlers.vaultReadText) {
        throw new Error('expected vaultReadText handler')
      }

      await expect(
        handlers.vaultReadText('YOLO/data/chats/v1_abc.json'),
      ).resolves.toBeNull()
    })

    it('reports null (not found) for vault.readBinary under the user data root', async () => {
      const chatFile = makeFile('YOLO/data/chats/v1_abc.json')
      const root = makeFolder('', [chatFile])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [chatFile]),
        { allowVaultRead: true },
        undefined,
        settings,
      )
      if (!handlers.vaultReadBinary) {
        throw new Error('expected vaultReadBinary handler')
      }

      await expect(
        handlers.vaultReadBinary('YOLO/data/chats/v1_abc.json'),
      ).resolves.toBeNull()
    })
  })

  describe('workspace scope exclusion (issue #577)', () => {
    const scope = { enabled: true, include: ['Notes'], exclude: [] }

    it('throws for an explicit vault.readText request outside scope, instead of returning null', async () => {
      const secretFile = makeFile('Private/secret.md')
      const root = makeFolder('', [secretFile])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [secretFile]),
        { allowVaultRead: true },
        undefined,
        undefined,
        scope,
      )
      if (!handlers.vaultReadText) {
        throw new Error('expected vaultReadText handler')
      }

      // Must reject, not resolve to null — null is this handler's
      // established "file genuinely does not exist" signal, and silently
      // returning it here would let the model wrongly conclude the file is
      // missing rather than merely out of its workspace scope.
      await expect(handlers.vaultReadText('Private/secret.md')).rejects.toThrow(
        'Path "Private/secret.md" is outside this agent\'s workspace scope.',
      )
    })

    it('throws for an explicit vault.readBinary request outside scope', async () => {
      const secretFile = makeFile('Private/secret.png')
      const root = makeFolder('', [secretFile])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [secretFile]),
        { allowVaultRead: true },
        undefined,
        undefined,
        scope,
      )
      if (!handlers.vaultReadBinary) {
        throw new Error('expected vaultReadBinary handler')
      }

      await expect(
        handlers.vaultReadBinary('Private/secret.png'),
      ).rejects.toThrow(
        'Path "Private/secret.png" is outside this agent\'s workspace scope.',
      )
    })

    it('silently drops out-of-scope entries from vault.list instead of erroring', async () => {
      const inScopeFile = makeFile('Notes/a.md')
      const outOfScopeFile = makeFile('Private/secret.md')
      const root = makeFolder('', [inScopeFile, outOfScopeFile])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [inScopeFile, outOfScopeFile]),
        { allowVaultRead: true },
        undefined,
        undefined,
        scope,
      )
      if (!handlers.vaultList) throw new Error('expected vaultList handler')

      // Only the in-scope file is returned — the out-of-scope one is
      // silently dropped, not reported as an error: enumeration must not
      // reveal "there's something here you can't see".
      await expect(handlers.vaultList('/')).resolves.toEqual([
        {
          kind: 'file',
          path: 'Notes/a.md',
          name: 'a.md',
          size: 10,
          mtime: 1000,
        },
      ])
    })

    it('allows traversal through an ancestor of an include rule in vault.list', async () => {
      const nestedFile = makeFile('Notes/Sub/a.md')
      const subFolder = makeFolder('Notes/Sub', [nestedFile])
      const notesFolder = makeFolder('Notes', [subFolder])
      const includeAncestorScope = {
        enabled: true,
        include: ['Notes/Sub'],
        exclude: [],
      }
      const root = makeFolder('', [notesFolder])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [notesFolder, subFolder, nestedFile]),
        { allowVaultRead: true },
        undefined,
        undefined,
        includeAncestorScope,
      )
      if (!handlers.vaultList) throw new Error('expected vaultList handler')

      // "Notes" is only an ancestor of the include rule "Notes/Sub", not
      // in-scope content itself — listing it must still succeed so the
      // agent can descend toward "Notes/Sub".
      await expect(handlers.vaultList('Notes')).resolves.toEqual([
        { kind: 'dir', path: 'Notes/Sub', name: 'Sub' },
      ])
    })

    it('drops out-of-scope rows from db.search', async () => {
      const root = makeFolder('', [])
      const processQuery = jest.fn().mockResolvedValue([
        {
          id: 1,
          path: 'Notes/a.md',
          content: 'in scope',
          similarity: 0.9,
          metadata: { startLine: 1, endLine: 5 },
        },
        {
          id: 2,
          path: 'Private/secret.md',
          content: 'shh',
          similarity: 0.8,
          metadata: { startLine: 1, endLine: 5 },
        },
      ])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, []),
        { allowDbQuery: true },
        {
          listKnowledgeBases: () => [
            {
              id: 'kb-a',
              name: 'kb-a',
              description: '',
              include: [],
              exclude: [],
            },
          ],
          getRagEngine: () => Promise.resolve({ processQuery } as never),
        },
        undefined,
        scope,
      )
      if (!handlers.dbQuery) throw new Error('expected dbQuery handler')

      // The RAG index spans the whole vault and each row carries the chunk's
      // real text, so an unfiltered search is a read path around workspace
      // scope. Retrieval is an enumeration — denied rows vanish silently.
      const rows = (await handlers.dbQuery('search', {
        query: 'secret',
      })) as Array<{ path: string }>
      expect(rows.map((row) => row.path)).toEqual(['Notes/a.md'])
      expect(JSON.stringify(rows)).not.toContain('shh')
    })

    it('pre-filters db.search at the vector-store scan by passing the workspace scope to processQuery', async () => {
      const root = makeFolder('', [])
      const processQuery = jest.fn().mockResolvedValue([])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, []),
        { allowDbQuery: true },
        {
          listKnowledgeBases: () => [
            {
              id: 'kb-a',
              name: 'kb-a',
              description: '',
              include: [],
              exclude: [],
            },
          ],
          getRagEngine: () => Promise.resolve({ processQuery } as never),
        },
        undefined,
        scope,
      )
      if (!handlers.dbQuery) throw new Error('expected dbQuery handler')

      await handlers.dbQuery('search', { query: 'secret' })

      // No `pathScope` here — db.search has no path argument — so the scope
      // passed to the vector store is derived purely from the workspace
      // scope, plus the always-on hidden user-data root exclude.
      expect(processQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: {
            files: ['Notes'],
            folders: ['Notes'],
            exclude: ['YOLO/data'],
          },
        }),
      )
    })

    it('still excludes the hidden user-data root from db.search when no workspace scope is configured', async () => {
      const root = makeFolder('', [])
      const processQuery = jest.fn().mockResolvedValue([])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, []),
        { allowDbQuery: true },
        {
          listKnowledgeBases: () => [
            {
              id: 'kb-a',
              name: 'kb-a',
              description: '',
              include: [],
              exclude: [],
            },
          ],
          getRagEngine: () => Promise.resolve({ processQuery } as never),
        },
        undefined,
        undefined,
      )
      if (!handlers.dbQuery) throw new Error('expected dbQuery handler')

      await handlers.dbQuery('search', { query: 'secret' })

      expect(processQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: { files: [], folders: [], exclude: ['YOLO/data'] },
        }),
      )
    })

    it('exempts an allowed skill path from workspace scope for vault.readText', async () => {
      const skillFile = makeFile('Skills/pkg/reference.md')
      const root = makeFolder('', [skillFile])
      const handlers = buildJsSandboxProxyHandlers(
        makeApp(root, [skillFile]),
        { allowVaultRead: true },
        undefined,
        undefined,
        scope,
        ['Skills/pkg/SKILL.md'],
      )
      if (!handlers.vaultReadText) {
        throw new Error('expected vaultReadText handler')
      }

      await expect(
        handlers.vaultReadText('Skills/pkg/reference.md'),
      ).resolves.toBe('content:Skills/pkg/reference.md')
    })
  })
})

describe('js sandbox browser page HTML handler', () => {
  const pageId = 'page_abcdefgh_12345678'
  const app = {} as App
  const handle = { pageId, webview: {} }

  beforeEach(() => {
    jest.mocked(findWebviewHandleByPageId).mockReset()
    jest.mocked(readActiveWebviewHtml).mockReset()
  })

  it('does not expose the handler when browser read is disabled', () => {
    const handlers = buildJsSandboxProxyHandlers(app, {})

    expect(handlers.browserReadHtml).toBeUndefined()
  })

  it('reads full HTML from an open page by page id', async () => {
    jest.mocked(findWebviewHandleByPageId).mockReturnValue(handle as never)
    jest.mocked(readActiveWebviewHtml).mockResolvedValue({
      url: 'https://example.com',
      title: 'Example',
      html: '<html><body>ok</body></html>',
      byteLength: 28,
    })
    const handlers = buildJsSandboxProxyHandlers(app, {
      allowBrowserRead: true,
    })

    await expect(handlers.browserReadHtml?.(pageId)).resolves.toEqual(
      expect.objectContaining({
        title: 'Example',
        html: '<html><body>ok</body></html>',
      }),
    )
    expect(findWebviewHandleByPageId).toHaveBeenCalledWith(app, pageId)
    expect(readActiveWebviewHtml).toHaveBeenCalledWith(handle, {
      maxBytes: JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB * 1024,
    })
  })

  it('accepts fs_read-style browser:// page paths', async () => {
    jest.mocked(findWebviewHandleByPageId).mockReturnValue(handle as never)
    jest.mocked(readActiveWebviewHtml).mockResolvedValue(null)
    const handlers = buildJsSandboxProxyHandlers(app, {
      allowBrowserRead: true,
    })

    await expect(
      handlers.browserReadHtml?.(`browser://${pageId}`),
    ).resolves.toBeNull()
    expect(findWebviewHandleByPageId).toHaveBeenCalledWith(app, pageId)
  })

  it('rejects URLs instead of treating them as browser pages', async () => {
    const handlers = buildJsSandboxProxyHandlers(app, {
      allowBrowserRead: true,
    })

    await expect(
      handlers.browserReadHtml?.('browser://https://example.com/article'),
    ).rejects.toThrow('browser:// paths only read open Obsidian web pages')
    expect(findWebviewHandleByPageId).not.toHaveBeenCalled()
  })
})

describe('js sandbox tool description', () => {
  it('mentions vault list only when vault read is enabled', () => {
    expect(buildJsSandboxToolDescription({})).not.toContain('$vault.list')

    const description = buildJsSandboxToolDescription({
      allowVaultRead: true,
    })
    expect(description).toContain('$vault.list')
    expect(description).toContain('do NOT return the full list')
  })

  it('describes db search and known-path text reads without keyword lookup', () => {
    const description = buildJsSandboxToolDescription({
      allowDbQuery: true,
    })

    expect(description).toContain('$db.search')
    expect(description).toContain('$vault.readText')
    expect(description).toContain(
      `clamped to ${JS_SANDBOX_DB_QUERY_DEFAULT_MAX_LIMIT}`,
    )
    expect(description).not.toContain('$db.get')
    expect(description).not.toContain('$db.find')
  })

  it('mentions browser HTML reads only when browser read is enabled', () => {
    expect(buildJsSandboxToolDescription({})).not.toContain('$browser.readHtml')

    const description = buildJsSandboxToolDescription({
      allowBrowserRead: true,
    })
    expect(description).toContain('$browser.readHtml')
    expect(description).toContain('document.documentElement.outerHTML')
    expect(description).toContain('$utils.html.extract')
    expect(description).toContain('$utils.html.select')
  })

  it('describes HTML parsing only once when fetch and browser read are both enabled', () => {
    const description = buildJsSandboxToolDescription({
      allowFetch: true,
      allowBrowserRead: true,
    })

    const htmlExtractMentions =
      description.match(/\$utils\.html\.extract/g) ?? []
    expect(htmlExtractMentions).toHaveLength(1)
  })

  it('does not duplicate vault readText guidance when db query and vault read are both enabled', () => {
    const description = buildJsSandboxToolDescription({
      allowDbQuery: true,
      allowVaultRead: true,
    })

    const readTextMentions = description.match(/\$vault\.readText/g) ?? []
    expect(readTextMentions).toHaveLength(1)
    expect(description).not.toContain('$db.get')
    expect(description).not.toContain('$db.find')
  })
})

describe('js sandbox tool output formatting', () => {
  it('keeps JSON output compact', () => {
    expect(
      formatJsSandboxToolText('{"items":[{"path":"a.md","count":2}]}'),
    ).toBe('{"items":[{"path":"a.md","count":2}]}')
  })

  it('keeps truncated output envelope compact', () => {
    const text = formatJsSandboxToolText(
      JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => i) }),
      { maxBytes: 1024 },
    )

    expect(text).not.toContain('\n')
    expect(JSON.parse(text)).toEqual(
      expect.objectContaining({
        truncated: true,
        warning: expect.any(String),
      }),
    )
  })
})

describe('local fs tool action helpers', () => {
  it('parses split file-op tools to fs actions', () => {
    expect(
      parseLocalFsActionFromToolArgs({
        toolName: 'fs_write',
        args: { path: 'a.md', content: 'x' },
      }),
    ).toBe('write')
    expect(
      parseLocalFsActionFromToolArgs({
        toolName: 'bash',
        args: { command: 'rm tmp' },
      }),
    ).toBeNull()
  })

  it('recognizes write tool names with local prefixes', () => {
    expect(isLocalFsWriteToolName('fs_edit')).toBe(true)
    expect(isLocalFsWriteToolName('yolo_local__fs_write')).toBe(true)
    expect(isLocalFsWriteToolName('yolo_local__bash')).toBe(false)
  })

  it('routes fs_edit approval through apply review', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({
        finalContent: 'hello changed',
        review: { totalChanges: 1, rejectedChanges: [] },
      })
      return true
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      openApplyReview,
      toolCallId: 'tool-call-1',
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        oldText: 'world',
        newText: 'changed',
      },
      requireReview: true,
    })

    expect(openApplyReview).toHaveBeenCalledTimes(1)
    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(editUndoSnapshotStore.get('tool-call-1', 'note.md')).toMatchObject({
      beforeContent: 'hello world',
      afterContent: 'hello changed',
    })
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 1,
      totalRemovedLines: 1,
      undoStatus: 'available',
    })
    const payload = JSON.parse(result.text) as Record<string, unknown>
    expect(payload).toMatchObject({
      tool: 'fs_edit',
      path: 'note.md',
      changed: true,
      review: { outcome: 'accepted' },
      message: 'Applied reviewed edit.',
    })
    expect(payload).not.toHaveProperty('appliedCount')
    expect(payload).not.toHaveProperty('operationResults')
  })

  it('reports partially rejected fs_edit review with compact previews', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const proposedText =
      'This proposed paragraph is intentionally much longer than forty characters.'
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({
        finalContent: 'hello changed',
        review: {
          totalChanges: 2,
          rejectedChanges: [
            {
              index: 2,
              originalText: 'world',
              proposedText,
            },
          ],
        },
      })
      return true
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read: jest.fn().mockResolvedValue('hello world'),
          modify: jest.fn(),
        },
      } as unknown as App,
      openApplyReview,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        oldText: 'world',
        newText: 'changed',
      },
      requireReview: true,
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      review: {
        outcome: string
        rejected: Array<{ index: number; preview: string }>
      }
      message: string
    }
    expect(payload.review.outcome).toBe('partially_rejected')
    expect(payload.review.rejected[0]?.index).toBe(2)
    expect(Array.from(payload.review.rejected[0]?.preview ?? '')).toHaveLength(
      40,
    )
    expect(payload.review.rejected[0]?.preview.endsWith('…')).toBe(true)
    expect(payload.message).toContain('Do not retry')
  })

  it('returns rejected when every reviewed fs_edit change is declined', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({
        finalContent: 'hello world',
        review: {
          totalChanges: 1,
          rejectedChanges: [
            { index: 1, originalText: 'world', proposedText: 'changed' },
          ],
        },
      })
      return true
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read: jest.fn().mockResolvedValue('hello world'),
          modify: jest.fn(),
        },
      } as unknown as App,
      openApplyReview,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        oldText: 'world',
        newText: 'changed',
      },
      requireReview: true,
    })

    expect(result).toEqual({
      status: ToolCallResponseStatus.Rejected,
      reason:
        'Explicit user decision: this change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.',
    })
  })

  it('treats fs_edit review close as abort without persisting', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onCancel?.()
      return true
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      openApplyReview,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        oldText: 'world',
        newText: 'changed',
      },
      requireReview: true,
    })

    expect(openApplyReview).toHaveBeenCalledTimes(1)
    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe('aborted')
  })

  it('supports fs_edit operations[] array of flat args as an atomic batch', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        operations: [
          {
            oldText: 'world',
            newText: 'changed',
          },
        ],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(modify).toHaveBeenCalledTimes(1)
    expect(modify.mock.calls[0][1]).toBe('hello changed')
  })

  it('applies multiple fs_edit operations atomically against a single snapshot', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 100 },
    })
    const modify = jest.fn()
    // Four lines so line-based edits have room to operate.
    const read = jest
      .fn()
      .mockResolvedValue(['alpha', 'beta', 'gamma', 'delta'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        // Intentionally provided in ASC startLine order to exercise the
        // engine's automatic descending reordering for replace_lines.
        operations: [
          { startLine: 1, endLine: 1, newText: 'A' },
          { startLine: 3, endLine: 3, newText: 'C' },
        ],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(modify).toHaveBeenCalledTimes(1)
    expect(modify.mock.calls[0][1]).toBe(['A', 'beta', 'C', 'delta'].join('\n'))
  })

  it('rejects fs_edit operations[] with overlapping replace_lines ranges', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 100 },
    })
    const modify = jest.fn()
    const read = jest
      .fn()
      .mockResolvedValue(['one', 'two', 'three', 'four'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        operations: [
          { startLine: 1, endLine: 2, newText: 'X' },
          { startLine: 2, endLine: 3, newText: 'Y' },
        ],
      },
    })

    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('overlap')
    }
  })

  it('supports fs_edit replace_lines operations', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue(['one', 'two', 'three'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        startLine: 2,
        endLine: 3,
        newText: ['dos', 'tres'].join('\n'),
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(modify).toHaveBeenCalledWith(file, ['one', 'dos', 'tres'].join('\n'))
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 2,
      totalRemovedLines: 2,
    })
  })

  it('returns a friendly hint when fs_edit replace matches the first line but not the full block', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 100 },
    })
    const modify = jest.fn()
    const read = jest
      .fn()
      .mockResolvedValue(['alpha', '\tbeta', 'gamma'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        oldText: ['alpha', '  beta'].join('\n'),
        newText: 'replaced',
      },
    })

    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('first line exists at line 1')
      expect(result.error).toContain('bash')
      expect(result.error).not.toContain('lineEndingNormalized')
    }
  })

  it('returns a friendly hint when fs_edit replace text is not found at all', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 100 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue(['alpha', 'beta'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        oldText: 'totally absent text',
        newText: 'replaced',
      },
    })

    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('Could not find the text to replace')
      expect(result.error).toContain('bash')
    }
  })

  it('rejects fs_edit when no locator is provided', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        newText: 'x',
      },
    })

    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('startLine+endLine')
    }
  })

  it('edits an oversized existing file without undo/review snapshot metadata', async () => {
    const over2mb = 2 * 1024 * 1024 + 1
    const largeContent = `${'x'.repeat(over2mb - 1)}z`
    const file = Object.assign(new TFile(), {
      path: 'large.md',
      stat: { size: over2mb },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue(largeContent)

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolCallId: 'tool-call-large-fs-edit',
      toolName: 'fs_edit',
      args: {
        path: 'large.md',
        oldText: 'z',
        newText: 'y',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(modify).toHaveBeenCalledWith(file, `${'x'.repeat(over2mb - 1)}y`)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata).toBeUndefined()
    expect(
      editUndoSnapshotStore.get('tool-call-large-fs-edit', 'large.md'),
    ).toBeUndefined()
  })

  it('skips undo/review snapshot when fs_edit inflates content above snapshot threshold', async () => {
    const over2mb = 2 * 1024 * 1024 + 1
    const file = Object.assign(new TFile(), {
      path: 'small.md',
      stat: { size: 6 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('small\n')

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolCallId: 'tool-call-inflate-fs-edit',
      toolName: 'fs_edit',
      args: {
        path: 'small.md',
        startLine: 1,
        endLine: 1,
        newText: 'x'.repeat(over2mb),
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(modify).toHaveBeenCalledWith(file, `${'x'.repeat(over2mb)}\n`)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata).toBeUndefined()
    expect(
      editUndoSnapshotStore.get('tool-call-inflate-fs-edit', 'small.md'),
    ).toBeUndefined()
  })

  it('rejects fs_edit when both oldText and a line range are provided', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
          modify,
        },
      } as unknown as App,
      toolName: 'fs_edit',
      args: {
        path: 'note.md',
        oldText: 'hello',
        startLine: 1,
        endLine: 1,
        newText: 'x',
      },
    })

    expect(modify).not.toHaveBeenCalled()
    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('not both')
    }
  })

  it('returns edit summary metadata for fs_write (create)', async () => {
    const create = jest.fn()

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create,
          createFolder: jest.fn(),
        },
      } as unknown as App,
      toolCallId: 'tool-call-create-1',
      toolName: 'fs_write',
      args: {
        path: 'note.md',
        content: ['one', 'two'].join('\n'),
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(create).toHaveBeenCalledWith('note.md', ['one', 'two'].join('\n'))
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 2,
      totalRemovedLines: 0,
      files: [{ operation: 'create' }],
    })
    expect(
      editUndoSnapshotStore.get('tool-call-create-1', 'note.md'),
    ).toMatchObject({
      beforeExists: false,
      afterExists: true,
    })
  })

  it('supports context prune tool results for any successful text tool output', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'edit-1',
                name: 'yolo_local__fs_edit',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
      ],
      args: {
        toolCallIds: [' edit-1 ', 'read-2', 'edit-1'],
        reason: 'superseded by newer reads',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-1',
      operation: 'prune_selected',
      acceptedToolCallIds: ['edit-1'],
      ignoredToolCallIds: ['read-2'],
      reason: 'superseded by newer reads',
    })
  })

  it('ignores tool results from the same tool message as prune', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-history',
          toolCalls: [
            {
              request: {
                id: 'edit-history',
                name: 'yolo_local__fs_edit',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-message-current',
          toolCalls: [
            {
              request: {
                id: 'edit-current',
                name: 'server__tool_a',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'prune-1',
                name: 'yolo_local__context_prune_tool_results',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Running,
              },
            },
          ],
        },
      ],
      args: {
        toolCallIds: ['edit-history', 'edit-current'],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-1',
      operation: 'prune_selected',
      acceptedToolCallIds: ['edit-history'],
      ignoredToolCallIds: ['edit-current'],
      reason: null,
    })
  })

  it('only accepts successful text non-control tool results for pruning', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'search-success',
                name: 'yolo_local__fs_search',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'edit-error',
                name: 'yolo_local__fs_edit',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Error,
                error: 'missing file',
              },
            },
            {
              request: {
                id: 'remote-aborted',
                name: 'server__tool_a',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Aborted,
              },
            },
            {
              request: {
                id: 'compact-success',
                name: 'yolo_local__context_compact',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
      ],
      args: {
        toolCallIds: [
          'search-success',
          'edit-error',
          'remote-aborted',
          'compact-success',
        ],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-1',
      operation: 'prune_selected',
      acceptedToolCallIds: ['search-success'],
      ignoredToolCallIds: ['edit-error', 'remote-aborted', 'compact-success'],
      reason: null,
    })
  })

  it('supports pruning all prunable tool results at once', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-all-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'search-1',
                name: 'yolo_local__fs_search',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'remote-1',
                name: 'server__tool_a',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
      ],
      args: {
        mode: 'all',
        reason: 'reset working set',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-all-1',
      operation: 'prune_all',
      acceptedToolCallIds: ['search-1', 'remote-1'],
      ignoredToolCallIds: [],
      reason: 'reset working set',
    })
  })

  it('returns success with empty accepted ids when mode is all and nothing is prunable', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-all-empty-1',
      toolName: 'context_prune_tool_results',
      conversationMessages: [
        {
          role: 'tool',
          id: 'tool-message-1',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: createCompleteToolCallArguments({ value: {} }),
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: '{}' },
              },
            },
          ],
        },
      ],
      args: {
        mode: 'all',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_prune_tool_results',
      toolCallId: 'prune-all-empty-1',
      operation: 'prune_all',
      acceptedToolCallIds: [],
      ignoredToolCallIds: [],
      reason: null,
    })
  })

  it('requires toolCallIds when mode is selected', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'prune-selected-empty-1',
      toolName: 'context_prune_tool_results',
      args: {
        mode: 'selected',
        toolCallIds: [],
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain(
        'toolCallIds cannot be empty when mode is selected.',
      )
    }
  })

  it('supports context compact control operation', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {},
      } as unknown as App,
      toolCallId: 'compact-1',
      toolName: 'context_compact',
      args: {
        reason: 'context window is crowded',
        instruction: 'preserve pending edits and file paths',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'context_compact',
      toolCallId: 'compact-1',
      operation: 'compact_restart',
      reason: 'context window is crowded',
      instruction: 'preserve pending edits and file paths',
    })
  })

  it('handles memory tools through local tool dispatcher', async () => {
    const entries = new Map<string, unknown>()
    const contents = new Map<string, string>()

    const app = {
      vault: {
        getAbstractFileByPath: jest
          .fn()
          .mockImplementation((path: string) => entries.get(path) ?? null),
        createFolder: jest.fn().mockImplementation(async (path: string) => {
          const folder = Object.assign(new TFolder(), {
            path,
            children: [],
          })
          entries.set(path, folder)
          return folder
        }),
        create: jest
          .fn()
          .mockImplementation(async (path: string, content: string) => {
            const file = Object.assign(new TFile(), {
              path,
              stat: { size: content.length },
            })
            entries.set(path, file)
            contents.set(path, content)
            return file
          }),
        read: jest
          .fn()
          .mockImplementation(
            async (file: TFile) => contents.get(file.path) ?? '',
          ),
        modify: jest
          .fn()
          .mockImplementation(async (file: TFile, content: string) => {
            contents.set(file.path, content)
            ;(file as { stat?: { size?: number } }).stat = {
              size: content.length,
            }
          }),
      },
    } as unknown as App

    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: 'Helper Agent',
          systemPrompt: 'You are helper.',
        },
      ],
    } as never

    const addResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_add',
      args: {
        content: '用户希望回答保持简洁',
        category: 'preferences',
      },
    })
    expect(addResult.status).toBe('success')
    const assistantMemoryPath = 'YOLO/memory/Helper Agent.md'
    expect(contents.get(assistantMemoryPath) ?? '').toContain(
      'Preference_1: 用户希望回答保持简洁',
    )

    const updateResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_update',
      args: {
        id: 'Preference_1',
        new_content: '用户希望回答保持简洁并直接',
      },
    })
    expect(updateResult.status).toBe('success')

    const deleteResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_delete',
      args: {
        id: 'Preference_1',
      },
    })
    expect(deleteResult.status).toBe('success')
    expect(contents.get(assistantMemoryPath) ?? '').not.toContain(
      'Preference_1',
    )
  })

  it('supports partial-success batch add and delete for memory tools', async () => {
    const entries = new Map<string, unknown>()
    const contents = new Map<string, string>()

    const app = {
      vault: {
        getAbstractFileByPath: jest
          .fn()
          .mockImplementation((path: string) => entries.get(path) ?? null),
        createFolder: jest.fn().mockImplementation(async (path: string) => {
          const folder = Object.assign(new TFolder(), {
            path,
            children: [],
          })
          entries.set(path, folder)
          return folder
        }),
        create: jest
          .fn()
          .mockImplementation(async (path: string, content: string) => {
            const file = Object.assign(new TFile(), {
              path,
              stat: { size: content.length },
            })
            entries.set(path, file)
            contents.set(path, content)
            return file
          }),
        read: jest
          .fn()
          .mockImplementation(
            async (file: TFile) => contents.get(file.path) ?? '',
          ),
        modify: jest
          .fn()
          .mockImplementation(async (file: TFile, content: string) => {
            contents.set(file.path, content)
            ;(file as { stat?: { size?: number } }).stat = {
              size: content.length,
            }
          }),
      },
    } as unknown as App

    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: 'Helper Agent',
          systemPrompt: 'You are helper.',
        },
      ],
    } as never

    const batchAddResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_add',
      args: {
        items: [
          {
            content: '批量记录 1',
            category: 'other',
          },
          {
            content: '   ',
            category: 'other',
          },
          {
            content: '批量记录 2',
            category: 'other',
          },
        ],
      },
    })
    expect(batchAddResult.status).toBe(ToolCallResponseStatus.Success)
    if (batchAddResult.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const batchAddPayload = JSON.parse(batchAddResult.text) as {
      mode: string
      okCount: number
      failCount: number
      results: Array<{ ok: boolean; id?: string }>
    }
    expect(batchAddPayload.mode).toBe('batch')
    expect(batchAddPayload.okCount).toBe(2)
    expect(batchAddPayload.failCount).toBe(1)
    const createdIds = batchAddPayload.results
      .filter((result) => result.ok)
      .map((result) => result.id)
    expect(createdIds).toEqual(['Memory_1', 'Memory_2'])

    const assistantMemoryPath = 'YOLO/memory/Helper Agent.md'

    const batchDeleteResult = await callLocalFileTool({
      app,
      settings,
      toolName: 'memory_delete',
      args: {
        ids: ['Memory_1', 'NotExist_404', 'Memory_2'],
      },
    })
    expect(batchDeleteResult.status).toBe(ToolCallResponseStatus.Success)
    if (batchDeleteResult.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const batchDeletePayload = JSON.parse(batchDeleteResult.text) as {
      mode: string
      okCount: number
      failCount: number
      results: Array<{ ok: boolean; id: string }>
    }
    expect(batchDeletePayload.mode).toBe('batch')
    expect(batchDeletePayload.okCount).toBe(2)
    expect(batchDeletePayload.failCount).toBe(1)
    expect(
      batchDeletePayload.results.filter((result) => !result.ok)[0]?.id,
    ).toBe('NotExist_404')

    expect(contents.get(assistantMemoryPath) ?? '').not.toContain('Memory_1')
    expect(contents.get(assistantMemoryPath) ?? '').not.toContain('Memory_2')
  })

  it('creates missing parent folders before creating a file', async () => {
    const entries = new Map<string, unknown>()
    const contents = new Map<string, string>()
    const createFolder = jest.fn().mockImplementation(async (path: string) => {
      const folder = Object.assign(new TFolder(), {
        path,
        children: [],
      })
      entries.set(path, folder)
      return folder
    })
    const create = jest
      .fn()
      .mockImplementation(async (path: string, content: string) => {
        const file = Object.assign(new TFile(), {
          path,
          stat: { size: content.length },
        })
        entries.set(path, file)
        contents.set(path, content)
        return file
      })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest
            .fn()
            .mockImplementation((path: string) => entries.get(path) ?? null),
          createFolder,
          create,
        },
      } as unknown as App,
      toolName: 'fs_write',
      args: {
        path: '99-Assets/YOLO/skills/content-organization/SKILL.md',
        content: '# test',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(createFolder).toHaveBeenNthCalledWith(1, '99-Assets')
    expect(createFolder).toHaveBeenNthCalledWith(2, '99-Assets/YOLO')
    expect(createFolder).toHaveBeenNthCalledWith(3, '99-Assets/YOLO/skills')
    expect(createFolder).toHaveBeenNthCalledWith(
      4,
      '99-Assets/YOLO/skills/content-organization',
    )
    expect(create).toHaveBeenCalledWith(
      '99-Assets/YOLO/skills/content-organization/SKILL.md',
      '# test',
    )
    expect(
      contents.get('99-Assets/YOLO/skills/content-organization/SKILL.md'),
    ).toBe('# test')
  })

  it('overwrites an existing file via fs_write and snapshots old content', async () => {
    const existing = Object.assign(new TFile(), {
      path: 'docs/a.md',
      stat: { size: 3 },
    })
    const read = jest.fn().mockResolvedValue('old')
    const modify = jest.fn()

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(existing),
          read,
          modify,
          create: jest.fn(),
          createFolder: jest.fn(),
        },
      } as unknown as App,
      toolCallId: 'tool-call-overwrite-1',
      toolName: 'fs_write',
      args: {
        path: 'docs/a.md',
        content: 'new content',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(modify).toHaveBeenCalledWith(existing, 'new content')
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      files: [{ operation: 'edit' }],
    })
    expect(
      editUndoSnapshotStore.get('tool-call-overwrite-1', 'docs/a.md'),
    ).toMatchObject({
      beforeExists: true,
      afterExists: true,
      beforeContent: 'old',
      afterContent: 'new content',
    })
  })

  it('rejects fs_write when the target path is an existing folder', async () => {
    const folder = Object.assign(new TFolder(), {
      path: 'docs',
      children: [],
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(folder),
          modify: jest.fn(),
          create: jest.fn(),
          createFolder: jest.fn(),
        },
      } as unknown as App,
      toolName: 'fs_write',
      args: {
        path: 'docs',
        content: 'x',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toMatch(/folder/i)
    }
  })

  it('keeps the fs_write tool schema flat without items or top-level combinators', () => {
    const tools = getLocalFileTools()
    const schemaByName = new Map(
      tools.map((tool) => [tool.name, tool.inputSchema] as const),
    )

    const schema = schemaByName.get('fs_write') as
      | {
          properties?: Record<string, unknown>
          required?: string[]
          oneOf?: unknown
          anyOf?: unknown
          allOf?: unknown
        }
      | undefined

    expect(schema).toBeDefined()
    expect(schema?.properties?.items).toBeUndefined()
    expect(schema?.required).toEqual(['path', 'content'])
    expect(schema?.oneOf).toBeUndefined()
    expect(schema?.anyOf).toBeUndefined()
    expect(schema?.allOf).toBeUndefined()
  })

  describe('workspace scope final defense', () => {
    const allowNotes = {
      enabled: true,
      include: ['Notes'],
      exclude: [],
    }

    it('rejects fs_edit when path is outside scope', async () => {
      const result = await callLocalFileTool({
        app: {
          vault: { getAbstractFileByPath: jest.fn() },
        } as unknown as App,
        toolName: 'fs_edit',
        args: {
          path: 'secret/a.md',
          oldText: 'x',
          newText: 'y',
        },
        workspaceScope: allowNotes,
      })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
      if (result.status === ToolCallResponseStatus.Error) {
        expect(result.error).toMatch(/workspace scope/i)
        expect(result.error).toMatch(/secret\/a\.md/)
      }
    })

    it('rejects fs_move when only newPath is outside scope', async () => {
      const result = await callLocalFileTool({
        app: {
          vault: {
            getAbstractFileByPath: jest.fn(),
          },
          fileManager: { renameFile: jest.fn() },
        } as unknown as App,
        toolName: 'fs_move',
        args: {
          oldPath: 'Notes/a.md',
          newPath: 'secret/a.md',
        },
        workspaceScope: allowNotes,
      })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
      if (result.status === ToolCallResponseStatus.Error) {
        expect(result.error).toMatch(/secret\/a\.md/)
      }
    })

    it('rejects fs_delete when path is outside scope', async () => {
      const result = await callLocalFileTool({
        app: {
          vault: { getAbstractFileByPath: jest.fn() },
        } as unknown as App,
        toolName: 'fs_delete',
        args: {
          path: 'secret/b.md',
        },
        workspaceScope: allowNotes,
      })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
      if (result.status === ToolCallResponseStatus.Error) {
        expect(result.error).toMatch(/secret\/b\.md/)
      }
    })

    it('rejects fs_write when path is outside scope', async () => {
      const result = await callLocalFileTool({
        app: {
          vault: {
            getAbstractFileByPath: jest.fn().mockReturnValue(null),
            create: jest.fn(),
            createFolder: jest.fn(),
          },
        } as unknown as App,
        toolName: 'fs_write',
        args: {
          path: 'secret/new.md',
          content: 'leak',
        },
        workspaceScope: allowNotes,
      })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
    })

    it('allows in-scope write operations when scope is enabled', async () => {
      const result = await callLocalFileTool({
        app: {
          vault: {
            getAbstractFileByPath: jest.fn().mockReturnValue(null),
            create: jest.fn(),
            createFolder: jest.fn(),
          },
        } as unknown as App,
        toolName: 'fs_write',
        args: {
          path: 'Notes/a.md',
          content: 'one',
        },
        workspaceScope: allowNotes,
      })
      expect(result.status).toBe(ToolCallResponseStatus.Success)
    })

    it('is a no-op when scope is disabled', async () => {
      const result = await callLocalFileTool({
        app: {
          vault: {
            getAbstractFileByPath: jest.fn().mockReturnValue(null),
            create: jest.fn(),
            createFolder: jest.fn(),
          },
        } as unknown as App,
        toolName: 'fs_write',
        args: {
          path: 'secret/a.md',
          content: 'ok',
        },
        workspaceScope: { enabled: false, include: ['Notes'], exclude: [] },
      })
      expect(result.status).toBe(ToolCallResponseStatus.Success)
    })
  })
})

describe('YOLO user data root final defense', () => {
  const settings = { yolo: { baseDir: 'YOLO' } } as unknown as YoloSettings

  it('keeps the not-found disguise when the path is also outside the workspace scope', async () => {
    const create = jest.fn()
    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create,
          createFolder: jest.fn(),
        },
      } as unknown as App,
      settings,
      toolName: 'fs_write',
      args: { path: 'YOLO/data/chats/v1_new.json', content: 'leak' },
      workspaceScope: { enabled: true, include: ['Notes'], exclude: [] },
    })

    // Hidden wins over scope: a scope-violation message would confirm the
    // path as a real, merely-restricted location — exactly what hiding the
    // user-data root is meant to prevent.
    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status !== ToolCallResponseStatus.Error) {
      throw new Error('expected error')
    }
    expect(result.error).toBe('File not found: YOLO/data/chats/v1_new.json')
    expect(result.error).not.toMatch(/workspace scope/i)
    expect(create).not.toHaveBeenCalled()
  })

  it('reports fs_write to the user data root as not found instead of writing', async () => {
    const create = jest.fn()
    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          create,
          createFolder: jest.fn(),
        },
      } as unknown as App,
      settings,
      toolName: 'fs_write',
      args: {
        path: 'YOLO/data/chats/v1_new.json',
        content: 'leak',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toBe('File not found: YOLO/data/chats/v1_new.json')
      expect(result.error).not.toMatch(/hidden|excluded|internal/i)
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('reports fs_edit on the user data root as not found instead of editing', async () => {
    const modify = jest.fn()
    const existingChatFile = Object.assign(new TFile(), {
      path: 'YOLO/data/chats/v1_abc.json',
      stat: { size: 20 },
    })
    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(existingChatFile),
          read: jest.fn().mockResolvedValue('{"title":"other conversation"}'),
          modify,
        },
      } as unknown as App,
      settings,
      toolName: 'fs_edit',
      args: {
        path: 'YOLO/data/chats/v1_abc.json',
        oldText: 'other',
        newText: 'tampered',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toBe('File not found: YOLO/data/chats/v1_abc.json')
    }
    expect(modify).not.toHaveBeenCalled()
  })

  it('reports fs_read on the user data root as not found without reading its content', async () => {
    const read = jest.fn().mockResolvedValue('{"title":"other conversation"}')
    const chatFile = Object.assign(new TFile(), {
      path: 'YOLO/data/chats/v1_abc.json',
      extension: 'json',
      stat: { size: 20 },
    })
    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest
            .fn()
            .mockImplementation((path: string) =>
              path === 'YOLO/data/chats/v1_abc.json' ? chatFile : null,
            ),
          read,
        },
        metadataCache: {
          getFirstLinkpathDest: jest.fn().mockReturnValue(null),
        },
      } as unknown as App,
      settings,
      toolName: 'fs_read',
      args: { paths: ['YOLO/data/chats/v1_abc.json'] },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      results: Array<{ path: string; ok: boolean; error?: string }>
    }
    expect(payload.results).toEqual([
      {
        path: 'YOLO/data/chats/v1_abc.json',
        ok: false,
        error: 'File not found: YOLO/data/chats/v1_abc.json',
      },
    ])
    expect(read).not.toHaveBeenCalled()
  })

  it('reports fs_read on a wikilink resolved into the user data root as not found', async () => {
    const read = jest.fn().mockResolvedValue('{"title":"other conversation"}')
    const chatFile = Object.assign(new TFile(), {
      path: 'YOLO/data/chats/v1_abc.json',
      extension: 'json',
      stat: { size: 20 },
    })
    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(null),
          read,
        },
        metadataCache: {
          getFirstLinkpathDest: jest
            .fn()
            .mockImplementation((linkpath: string) =>
              linkpath === 'v1_abc' ? chatFile : null,
            ),
          getFileCache: jest.fn().mockReturnValue(null),
        },
      } as unknown as App,
      settings,
      toolName: 'fs_read',
      args: { paths: ['[[v1_abc]]'] },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      results: Array<{ path: string; ok: boolean; error?: string }>
    }
    expect(payload.results).toEqual([
      {
        path: '[[v1_abc]]',
        ok: false,
        error: 'File not found: [[v1_abc]]',
      },
    ])
    expect(read).not.toHaveBeenCalled()
  })
})

describe('callLocalFileTool: dispatcher-level boundaries (D5 parity with executeBuiltinTool)', () => {
  it('returns Aborted without touching the vault when signal is already aborted', async () => {
    const getAbstractFileByPath = jest.fn()
    const controller = new AbortController()
    controller.abort()

    const result = await callLocalFileTool({
      app: {
        vault: { getAbstractFileByPath },
      } as unknown as App,
      toolName: 'fs_edit',
      args: { path: 'note.md', oldText: 'x', newText: 'y' },
      signal: controller.signal,
    })

    expect(result).toEqual({ status: ToolCallResponseStatus.Aborted })
    expect(getAbstractFileByPath).not.toHaveBeenCalled()
  })

  it('returns an explicit error for an unknown tool name instead of throwing', async () => {
    const result = await callLocalFileTool({
      app: { vault: {} } as unknown as App,
      toolName: 'not_a_real_tool',
      args: {},
    })

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'Unknown local file tool: not_a_real_tool',
    })
  })
})

describe('fs_read wikilink resolution', () => {
  const makeMdFile = (path: string, size = 20, mtime = 1000): TFile =>
    Object.assign(new TFile(), {
      path,
      name: path.split('/').pop(),
      extension: 'md',
      stat: { size, mtime },
    })

  type FakeHeading = { heading: string; level: number; line0: number }

  const makeReadApp = (options: {
    content: Record<string, string>
    resolver: (linkpath: string, sourcePath: string) => TFile | null
    headingsByFile?: Map<TFile, FakeHeading[]>
  }): App => {
    const { content, resolver, headingsByFile } = options
    return {
      vault: {
        getFileByPath: jest.fn().mockReturnValue(null),
        read: jest
          .fn()
          .mockImplementation((file: TFile) =>
            Promise.resolve(content[file.path] ?? ''),
          ),
      },
      metadataCache: {
        getFirstLinkpathDest: jest.fn(resolver),
        getFileCache: jest.fn().mockImplementation((file: TFile) => {
          const headings = headingsByFile?.get(file)
          if (!headings) return null
          return {
            headings: headings.map((h) => ({
              heading: h.heading,
              level: h.level,
              position: {
                start: { line: h.line0, col: 0, offset: 0 },
                end: { line: h.line0, col: 0, offset: 0 },
              },
            })),
          }
        }),
      },
    } as unknown as App
  }

  const parseSuccessResults = (result: {
    status: ToolCallResponseStatus
    text?: string
  }): Array<Record<string, unknown>> => {
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    return (
      JSON.parse((result as { text: string }).text) as {
        results: Array<Record<string, unknown>>
      }
    ).results
  }

  it('resolves a [[...]]-style path entry that has no exact vault match', async () => {
    const file = makeMdFile('Notes/Foo.md')
    const app = makeReadApp({
      content: { 'Notes/Foo.md': 'line1\nline2\nline3' },
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
    })

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['[[Foo]]'] },
    })

    const results = parseSuccessResults(result)
    expect(results).toEqual([
      expect.objectContaining({
        path: '[[Foo]]',
        ok: true,
        resolvedPath: 'Notes/Foo.md',
        content: '1|line1\n2|line2\n3|line3',
      }),
    ])
  })

  it('leaves exact vault-path matches unaffected (no resolvedPath)', async () => {
    const file = makeMdFile('Notes/Foo.md')
    const app: App = {
      vault: {
        getFileByPath: jest
          .fn()
          .mockImplementation((path: string) =>
            path === 'Notes/Foo.md' ? file : null,
          ),
        read: jest.fn().mockResolvedValue('hello'),
      },
      metadataCache: {
        getFirstLinkpathDest: jest.fn().mockReturnValue(null),
        getFileCache: jest.fn().mockReturnValue(null),
      },
    } as unknown as App

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['Notes/Foo.md'] },
    })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({ path: 'Notes/Foo.md', ok: true }),
    )
    expect(results[0]?.resolvedPath).toBeUndefined()
  })

  it('applies a resolved heading subpath as the effective range on a full read', async () => {
    const file = makeMdFile('Notes/Foo.md')
    const app = makeReadApp({
      content: {
        'Notes/Foo.md':
          'Intro\nSection A\nBody A\nSub A.1\nBody A.1\nSection B\nBody B',
      },
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
      headingsByFile: new Map([
        [
          file,
          [
            { heading: 'Section A', level: 1, line0: 1 },
            { heading: 'Sub A.1', level: 2, line0: 3 },
            { heading: 'Section B', level: 1, line0: 5 },
          ],
        ],
      ]),
    })

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['[[Foo#Section A]]'] },
    })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({
        path: '[[Foo#Section A]]',
        ok: true,
        resolvedPath: 'Notes/Foo.md',
        resolvedSubpath: { type: 'heading', startLine: 2, endLine: 5 },
        returnedRange: { startLine: 2, endLine: 5 },
        // 1-based lines 2-5: "Section A", "Body A", "Sub A.1", "Body A.1" —
        // stops before "Section B" (same level as "Section A").
        content: '2|Section A\n3|Body A\n4|Sub A.1\n5|Body A.1',
      }),
    )
  })

  it('lets an explicit startLine/endLine override the resolved subpath range', async () => {
    const file = makeMdFile('Notes/Foo.md')
    const app = makeReadApp({
      content: {
        'Notes/Foo.md': 'Intro\nSection A\nBody A\nSection B\nBody B',
      },
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
      headingsByFile: new Map([
        [
          file,
          [
            { heading: 'Section A', level: 1, line0: 1 },
            { heading: 'Section B', level: 1, line0: 3 },
          ],
        ],
      ]),
    })

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['[[Foo#Section A]]'], startLine: 1, endLine: 1 },
    })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({
        ok: true,
        // Section A (1-based line 2) runs through Body A (line 3), stopping
        // before Section B (line 4) — but the explicit startLine/endLine
        // below overrides this for the actual returned range.
        resolvedSubpath: { type: 'heading', startLine: 2, endLine: 3 },
        returnedRange: { startLine: 1, endLine: 1 },
        content: '1|Intro',
      }),
    )
  })

  it('falls back to a full read with a warning when the subpath is not found', async () => {
    const file = makeMdFile('Notes/Foo.md')
    const app = makeReadApp({
      content: { 'Notes/Foo.md': 'line1\nline2' },
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
      headingsByFile: new Map([[file, []]]),
    })

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['[[Foo#Missing]]'] },
    })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({
        ok: true,
        resolvedPath: 'Notes/Foo.md',
        content: '1|line1\n2|line2',
      }),
    )
    expect(results[0]?.resolvedSubpath).toBeUndefined()
    expect(results[0]?.warning).toMatch(/Missing/)
  })

  it('reports an actionable error when the wikilink target cannot be resolved', async () => {
    const app = makeReadApp({
      content: {},
      resolver: () => null,
    })

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['[[Missing]]'] },
    })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual({
      path: '[[Missing]]',
      ok: false,
      error:
        'File not found. "[[Missing]]" did not match a vault path or a resolvable wikilink target.',
    })
  })

  it('rejects a wikilink target that resolves outside the workspace scope, without leaking the resolved path (issue #577)', async () => {
    const file = makeMdFile('Private/Secret.md')
    const app = makeReadApp({
      content: { 'Private/Secret.md': 'shh' },
      resolver: (linkpath) => (linkpath === 'Secret' ? file : null),
    })

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['[[Secret]]'] },
      workspaceScope: { enabled: true, include: ['Notes'], exclude: [] },
    })

    const results = parseSuccessResults(result)
    // The error must echo the agent's own unresolved input ("[[Secret]]"),
    // never the real vault path ("Private/Secret.md") it resolved to — an
    // agent scoped away from Private/ has no way to know a wikilink lands
    // there, and the denial message must not be how it finds out.
    expect(results[0]).toEqual({
      path: '[[Secret]]',
      ok: false,
      error: 'Path "[[Secret]]" is outside this agent\'s workspace scope.',
    })
    const resultText = JSON.stringify(results[0])
    expect(resultText).not.toContain('Private/Secret.md')
  })

  it('allows a wikilink target that resolves inside the workspace scope', async () => {
    const file = makeMdFile('Notes/Foo.md')
    const app = makeReadApp({
      content: { 'Notes/Foo.md': 'in scope' },
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
    })

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['[[Foo]]'] },
      workspaceScope: { enabled: true, include: ['Notes'], exclude: [] },
    })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({ ok: true, resolvedPath: 'Notes/Foo.md' }),
    )
  })

  it('still enforces workspace scope for an exact-match fs_read path (no gateway-level pre-check anymore)', async () => {
    const file = makeMdFile('Private/Secret.md')
    const app: App = {
      vault: {
        getFileByPath: jest
          .fn()
          .mockImplementation((path: string) =>
            path === 'Private/Secret.md' ? file : null,
          ),
        read: jest.fn().mockResolvedValue('shh'),
      },
      metadataCache: {
        getFirstLinkpathDest: jest.fn().mockReturnValue(null),
        getFileCache: jest.fn().mockReturnValue(null),
      },
    } as unknown as App

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['Private/Secret.md'] },
      workspaceScope: { enabled: true, include: ['Notes'], exclude: [] },
    })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual({
      path: 'Private/Secret.md',
      ok: false,
      error:
        'Path "Private/Secret.md" is outside this agent\'s workspace scope.',
    })
  })

  it('keeps the skill package exemption for out-of-scope files inside an allowed skill directory', async () => {
    const file = makeMdFile('Skills/pkg/reference.md')
    const app: App = {
      vault: {
        getFileByPath: jest
          .fn()
          .mockImplementation((path: string) =>
            path === 'Skills/pkg/reference.md' ? file : null,
          ),
        read: jest.fn().mockResolvedValue('skill reference content'),
      },
      metadataCache: {
        getFirstLinkpathDest: jest.fn().mockReturnValue(null),
        getFileCache: jest.fn().mockReturnValue(null),
      },
    } as unknown as App

    const result = await callLocalFileTool({
      app,
      toolName: 'fs_read',
      args: { paths: ['Skills/pkg/reference.md'] },
      workspaceScope: { enabled: true, include: ['Notes'], exclude: [] },
      allowedSkillPaths: ['Skills/pkg/SKILL.md'],
    })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({ path: 'Skills/pkg/reference.md', ok: true }),
    )
  })
})

describe('bash tool dispatch', () => {
  const mockApp = { vault: {}, fileManager: {} } as unknown as App

  const mockBashEngine = (
    execImpl: (
      command: string,
      confirm: (
        kind: 'rm' | 'mv',
        targets: readonly string[],
      ) => Promise<boolean>,
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  ) => {
    let capturedConfirm:
      | ((kind: 'rm' | 'mv', targets: readonly string[]) => Promise<boolean>)
      | undefined
    const dispose = jest.fn()
    const release = jest.fn()
    setRuntimeComponentAcquirerForTests(
      async <I extends RuntimeComponentId>(
        id: I,
      ): Promise<RuntimeComponentLease<I>> => {
        if (id !== 'bash-engine') throw new Error('Unexpected component')
        const api = {
          createSession: jest.fn().mockImplementation((options) => {
            capturedConfirm = options.confirmDangerousOperation
            return {
              exec: (command: string) =>
                execImpl(command, options.confirmDangerousOperation),
              dispose,
            }
          }),
          dispose: async () => undefined,
        }
        return { api, release } as unknown as RuntimeComponentLease<I>
      },
    )
    return {
      release,
      dispose,
      getCapturedConfirm: () => capturedConfirm,
    }
  }

  it('runs a command and returns stdout/stderr/exit_code as JSON', async () => {
    const { release } = mockBashEngine(async (command) => {
      expect(command).toBe('ls')
      return { stdout: 'a.md\nb.md\n', stderr: '', exitCode: 0 }
    })

    const result = await callLocalFileTool({
      app: mockApp,
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 'call-1',
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(JSON.parse(result.text)).toEqual({
      tool: 'bash',
      exit_code: 0,
      stdout: 'a.md\nb.md\n',
      stderr: '',
    })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('never pauses for confirmation under full_access', async () => {
    mockBashEngine(async (command, confirm) => {
      const approved = await confirm('rm', ['/vault/a.md'])
      expect(approved).toBe(true)
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const result = await callLocalFileTool({
      app: mockApp,
      toolName: 'bash',
      args: { command: 'rm a.md' },
      toolCallId: 'call-2',
      bashApprovalMode: 'full_access',
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    // No pending dangerous approval should ever have been raised.
    expect(getPendingDangerousBashApproval('call-2')).toBeNull()
  })

  it('never pauses for confirmation under require_approval (the whole call was already gated)', async () => {
    mockBashEngine(async (command, confirm) => {
      const approved = await confirm('mv', ['/vault/a.md -> /vault/b.md'])
      expect(approved).toBe(true)
      return { stdout: '', stderr: '', exitCode: 0 }
    })

    const result = await callLocalFileTool({
      app: mockApp,
      toolName: 'bash',
      args: { command: 'mv a.md b.md' },
      toolCallId: 'call-3',
      bashApprovalMode: 'require_approval',
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(getPendingDangerousBashApproval('call-3')).toBeNull()
  })

  it('pauses mid-script for rm/mv under dangerous_only and resumes once resolved', async () => {
    const { getCapturedConfirm } = mockBashEngine(async (command, confirm) => {
      const approved = await confirm('rm', ['/vault/a.md'])
      return {
        stdout: approved ? 'removed' : '',
        stderr: approved ? '' : 'operation denied by user',
        exitCode: approved ? 0 : 1,
      }
    })

    const resultPromise = callLocalFileTool({
      app: mockApp,
      toolName: 'bash',
      args: { command: 'rm a.md' },
      toolCallId: 'call-4',
      bashApprovalMode: 'dangerous_only',
    })

    // Give the dispatch a tick to reach the confirm() call and register the
    // pending request.
    await Promise.resolve()
    await Promise.resolve()

    const pending = getPendingDangerousBashApproval('call-4')
    expect(pending).toMatchObject({ kind: 'rm', targets: ['/vault/a.md'] })
    expect(getCapturedConfirm()).toBeDefined()

    resolveDangerousBashApproval('call-4', pending!.requestId, true)

    const result = await resultPromise
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(JSON.parse(result.text)).toMatchObject({
      exit_code: 0,
      stdout: 'removed',
    })
  })

  it('denying a dangerous operation returns a nonzero exit code without failing the tool call', async () => {
    mockBashEngine(async (command, confirm) => {
      const approved = await confirm('rm', ['/vault/a.md'])
      return {
        stdout: '',
        stderr: approved ? '' : 'operation denied by user',
        exitCode: approved ? 0 : 1,
      }
    })

    const resultPromise = callLocalFileTool({
      app: mockApp,
      toolName: 'bash',
      args: { command: 'rm a.md' },
      toolCallId: 'call-5',
      bashApprovalMode: 'dangerous_only',
    })

    await Promise.resolve()
    await Promise.resolve()
    const pending = getPendingDangerousBashApproval('call-5')
    resolveDangerousBashApproval('call-5', pending!.requestId, false)

    const result = await resultPromise
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      exit_code: number
      stderr: string
    }
    expect(payload.exit_code).toBe(1)
    expect(payload.stderr).toContain('operation denied by user')
  })

  it('fails closed (denies) when there is no toolCallId to attach an approval card to', async () => {
    mockBashEngine(async (command, confirm) => {
      const approved = await confirm('rm', ['/vault/a.md'])
      expect(approved).toBe(false)
      return { stdout: '', stderr: '', exitCode: approved ? 0 : 1 }
    })

    const result = await callLocalFileTool({
      app: mockApp,
      toolName: 'bash',
      args: { command: 'rm a.md' },
      bashApprovalMode: 'dangerous_only',
      // toolCallId intentionally omitted.
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
  })

  it('passes readOnly through to the bash-engine session when bashReadOnly is set', async () => {
    let createSessionOptions: { readOnly?: boolean } | undefined
    setRuntimeComponentAcquirerForTests(
      async <I extends RuntimeComponentId>(
        id: I,
      ): Promise<RuntimeComponentLease<I>> => {
        if (id !== 'bash-engine') throw new Error('Unexpected component')
        const api = {
          createSession: jest.fn().mockImplementation((options) => {
            createSessionOptions = options
            return {
              exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
              dispose: jest.fn(),
            }
          }),
          dispose: async () => undefined,
        }
        return {
          api,
          release: jest.fn(),
        } as unknown as RuntimeComponentLease<I>
      },
    )

    await callLocalFileTool({
      app: mockApp,
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 'call-readonly',
      bashReadOnly: true,
    })

    expect(createSessionOptions?.readOnly).toBe(true)
  })

  it('defaults readOnly to false when bashReadOnly is not set', async () => {
    let createSessionOptions: { readOnly?: boolean } | undefined
    setRuntimeComponentAcquirerForTests(
      async <I extends RuntimeComponentId>(
        id: I,
      ): Promise<RuntimeComponentLease<I>> => {
        if (id !== 'bash-engine') throw new Error('Unexpected component')
        const api = {
          createSession: jest.fn().mockImplementation((options) => {
            createSessionOptions = options
            return {
              exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
              dispose: jest.fn(),
            }
          }),
          dispose: async () => undefined,
        }
        return {
          api,
          release: jest.fn(),
        } as unknown as RuntimeComponentLease<I>
      },
    )

    await callLocalFileTool({
      app: mockApp,
      toolName: 'bash',
      args: { command: 'ls' },
      toolCallId: 'call-writable',
    })

    expect(createSessionOptions?.readOnly).toBe(false)
  })
})

describe('delegate_subagent model selection', () => {
  const buildSettings = (): YoloSettings =>
    ({
      providers: [
        {
          id: 'openai',
          presetType: 'openai',
          apiType: 'openai-compatible',
          apiKey: 'token',
        },
      ],
      chatModelId: 'openai/gpt-5',
      chatModels: [
        {
          id: 'openai/gpt-5',
          providerId: 'openai',
          model: 'gpt-5',
          enable: true,
        },
        {
          id: 'openai/gpt-4.1-mini',
          providerId: 'openai',
          model: 'gpt-4.1-mini',
          enable: true,
        },
      ],
      mcp: {
        servers: [],
        enableToolDisclosure: false,
        builtinCapabilityOptions: {
          subagent_delegation: {
            allowedModelIds: ['openai/gpt-5', 'openai/gpt-4.1-mini'],
            preferredModelId: 'openai/gpt-4.1-mini',
          },
        },
      },
    }) as unknown as YoloSettings

  const callDelegateSubagent = (args: Record<string, unknown>) =>
    callLocalFileTool({
      app: {} as App,
      settings: buildSettings(),
      conversationId: 'conv',
      conversationMessages: [],
      toolCallId: 'tool-call',
      toolName: 'delegate_subagent',
      args: {
        description: 'Scan',
        prompt: 'Scan notes',
        ...args,
      },
      subagentParentContext: {} as never,
    })

  it('uses explicit modelId when it is in the subagent model pool', async () => {
    const result = await callDelegateSubagent({ modelId: 'openai/gpt-5' })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(runSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        childModel: expect.objectContaining({
          model: expect.objectContaining({ id: 'openai/gpt-5' }),
        }),
      }),
    )
  })

  it('uses the preferred subagent model when modelId is omitted', async () => {
    const result = await callDelegateSubagent({})

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(runSubagent).toHaveBeenCalledWith(
      expect.objectContaining({
        childModel: expect.objectContaining({
          model: expect.objectContaining({ id: 'openai/gpt-4.1-mini' }),
        }),
      }),
    )
  })

  it('rejects modelId values outside the subagent model pool', async () => {
    const result = await callDelegateSubagent({ modelId: 'openai/forbidden' })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status !== ToolCallResponseStatus.Error) {
      throw new Error('Expected delegate_subagent to reject forbidden modelId')
    }
    expect(result.error).toContain('not allowed for delegate_subagent')
    expect(runSubagent).not.toHaveBeenCalled()
  })
})
