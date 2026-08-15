// Proves the ported `fs_read` `execute()` implementation
// (src/core/tools/fs_read/definition.ts) behaves identically to the
// still-present `case 'fs_read'` branch of `callLocalFileTool` it was copied
// from — per D6 batch 3's exit condition. This is the batch's key
// verification point (phase2-migration.md D6 batch 3): the dynamic
// `modality` schema field and the two path checks that must stay inside the
// tool rather than move to the dispatcher (master.md §5's "解析级检查"
// carve-out — YOLO-data-root and workspace-scope re-checks on a
// wikilink-resolved path, which never appears as a literal string in
// `args`).
//
// `callLocalFileTool` is NOT the delegation boundary (D6a fix) — the fork
// between the old switch and the new dispatcher lives at
// `McpManager.callTool`'s local-tool branch in `core/mcp/mcpManager.ts`, not
// inside `callLocalFileTool`. Calling `callLocalFileTool` directly here
// exercises its own still-live switch case, which is exactly the "old"
// baseline this file compares against. `registry.test.ts`'s
// `isBuiltinToolName('fs_read')` coverage is what proves this tool actually
// routes through the new path at the real call site.

jest.mock('obsidian')

import { App, TFile } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { AssistantWorkspaceScope } from '../../types/assistant.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { callLocalFileTool, getLocalFileTools } from '../mcp/localFileTools'

import { executeBuiltinTool } from './dispatcher'
import { fsReadDefinition } from './fs_read/definition'
import type { ToolContext } from './types'

const app = {} as App

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return { app, ...overrides }
}

const makeMdFile = (path: string, size = 20, mtime = 1000): TFile =>
  Object.assign(new TFile(), {
    path,
    name: path.split('/').pop(),
    extension: 'md',
    stat: { size, mtime },
  })

/** Minimal read-capable mock vault app, mirroring localFileTools.test.ts's `fs_read wikilink resolution` fixtures. */
const makeReadApp = (options: {
  content: Record<string, string>
  resolver?: (linkpath: string, sourcePath: string) => TFile | null
}): App => {
  const { content, resolver } = options
  return {
    vault: {
      getFileByPath: jest
        .fn()
        .mockImplementation((path: string) =>
          Object.prototype.hasOwnProperty.call(content, path)
            ? makeMdFile(path)
            : null,
        ),
      read: jest
        .fn()
        .mockImplementation((file: TFile) =>
          Promise.resolve(content[file.path] ?? ''),
        ),
    },
    metadataCache: {
      getFirstLinkpathDest: jest.fn(resolver ?? (() => null)),
      getFileCache: jest.fn().mockReturnValue(null),
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

describe('fs_read execute() vs callLocalFileTool', () => {
  it('full read of an existing markdown file: same result', async () => {
    const readApp = makeReadApp({
      content: { 'Notes/a.md': 'line1\nline2\nline3' },
    })
    const args = { paths: ['Notes/a.md'] }

    const oldResult = await callLocalFileTool({
      app: readApp,
      toolName: 'fs_read',
      args,
    })
    const newResult = await fsReadDefinition.execute(
      args,
      makeCtx({ app: readApp }),
    )

    expect(newResult).toEqual(oldResult)
    expect(parseSuccessResults(oldResult)).toEqual([
      expect.objectContaining({
        path: 'Notes/a.md',
        ok: true,
        content: '1|line1\n2|line2\n3|line3',
      }),
    ])
  })

  it('missing file: same not-found error entry', async () => {
    const readApp = makeReadApp({ content: {} })
    const args = { paths: ['Notes/missing.md'] }

    const oldResult = await callLocalFileTool({
      app: readApp,
      toolName: 'fs_read',
      args,
    })
    const newResult = await fsReadDefinition.execute(
      args,
      makeCtx({ app: readApp }),
    )

    expect(newResult).toEqual(oldResult)
    expect(parseSuccessResults(oldResult)[0]).toEqual(
      expect.objectContaining({ path: 'Notes/missing.md', ok: false }),
    )
  })

  it('empty paths array: old wraps to an Error result, new throws for the dispatcher to normalize', async () => {
    const readApp = makeReadApp({ content: {} })
    const args = { paths: [] }

    const oldResult = await callLocalFileTool({
      app: readApp,
      toolName: 'fs_read',
      args,
    })
    expect(oldResult).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'paths cannot be empty.',
    })

    await expect(
      fsReadDefinition.execute(args, makeCtx({ app: readApp })),
    ).rejects.toThrow('paths cannot be empty.')
  })

  it('wikilink resolution: same resolvedPath and content', async () => {
    const file = makeMdFile('Notes/Foo.md')
    const readApp = makeReadApp({
      content: { 'Notes/Foo.md': 'line1\nline2' },
      resolver: (linkpath) => (linkpath === 'Foo' ? file : null),
    })
    const args = { paths: ['[[Foo]]'] }

    const oldResult = await callLocalFileTool({
      app: readApp,
      toolName: 'fs_read',
      args,
    })
    const newResult = await fsReadDefinition.execute(
      args,
      makeCtx({ app: readApp }),
    )

    expect(newResult).toEqual(oldResult)
    expect(parseSuccessResults(oldResult)[0]).toEqual(
      expect.objectContaining({
        path: '[[Foo]]',
        ok: true,
        resolvedPath: 'Notes/Foo.md',
        content: '1|line1\n2|line2',
      }),
    )
  })

  // The "解析级检查" this batch must keep inside the tool (master.md §5):
  // the YOLO-data-root path is only known after wikilink resolution, so the
  // dispatcher's raw-argument scan cannot see it — `[[Secret]]` is not
  // itself a path under the data root.
  it('YOLO-data-root re-check after wikilink resolution: same not-found result', async () => {
    const dataFile = makeMdFile('YOLO/data/chats/secret.md')
    const readApp = makeReadApp({
      content: { 'YOLO/data/chats/secret.md': 'hidden' },
      resolver: (linkpath) => (linkpath === 'Secret' ? dataFile : null),
    })
    const settings = { yolo: { baseDir: 'YOLO' } } as unknown as YoloSettings
    const args = { paths: ['[[Secret]]'] }

    const oldResult = await callLocalFileTool({
      app: readApp,
      settings,
      toolName: 'fs_read',
      args,
    })
    const newResult = await fsReadDefinition.execute(
      args,
      makeCtx({ app: readApp, settings }),
    )

    expect(newResult).toEqual(oldResult)
    expect(parseSuccessResults(oldResult)[0]).toEqual({
      path: '[[Secret]]',
      ok: false,
      error: 'File not found: "[[Secret]]".',
    })
  })

  // Same carve-out, for workspace scope: the resolved vault path
  // ("Secret/note.md") is what must be checked against scope, not the
  // literal "[[Note]]" argument.
  it('workspace-scope re-check after wikilink resolution: same rejection', async () => {
    const file = makeMdFile('Secret/note.md')
    const readApp = makeReadApp({
      content: { 'Secret/note.md': 'hidden' },
      resolver: (linkpath) => (linkpath === 'Note' ? file : null),
    })
    const workspaceScope: AssistantWorkspaceScope = {
      enabled: true,
      include: ['Notes'],
      exclude: [],
    }
    const args = { paths: ['[[Note]]'] }

    const oldResult = await callLocalFileTool({
      app: readApp,
      workspaceScope,
      toolName: 'fs_read',
      args,
    })
    const newResult = await fsReadDefinition.execute(
      args,
      makeCtx({ app: readApp, workspaceScope }),
    )

    expect(newResult).toEqual(oldResult)
    expect(parseSuccessResults(oldResult)[0]).toEqual({
      path: '[[Note]]',
      ok: false,
      error: 'Path "Secret/note.md" is outside this agent\'s workspace scope.',
    })
  })
})

describe('executeBuiltinTool (dispatcher) vs callLocalFileTool end-to-end: fs_read', () => {
  it('matches for a successful read', async () => {
    const readApp = makeReadApp({ content: { 'a.md': 'hi' } })
    const args = { paths: ['a.md'] }

    const oldResult = await callLocalFileTool({
      app: readApp,
      toolName: 'fs_read',
      args,
    })
    const newResult = await executeBuiltinTool(
      'fs_read',
      args,
      makeCtx({ app: readApp }),
    )

    expect(newResult).toEqual(oldResult)
  })
})

describe('fs_read dynamic modality schema (getMcpTool)', () => {
  it('omits `modality` entirely for a text-only model', () => {
    const schema = fsReadDefinition.getMcpTool({ chatModelModalities: [] })
    expect(schema.inputSchema.properties).not.toHaveProperty('modality')
  })

  it('exposes the full [text, image, pdf] superset when no model context is supplied at all (UI/permission-listing branch)', () => {
    const schema = fsReadDefinition.getMcpTool({})
    expect(
      (schema.inputSchema.properties as Record<string, { enum?: string[] }>)
        .modality?.enum,
    ).toEqual(['text', 'image', 'pdf'])
  })

  it('exposes modality [text, image] for a vision-capable (non-PDF) model', () => {
    const schema = fsReadDefinition.getMcpTool({
      chatModelModalities: ['vision'],
    })
    expect(schema.inputSchema.properties).toHaveProperty('modality')
    expect(
      (schema.inputSchema.properties as Record<string, { enum?: string[] }>)
        .modality?.enum,
    ).toEqual(['text', 'image'])
  })

  it('exposes modality [text, pdf] for a PDF-capable model', () => {
    const schema = fsReadDefinition.getMcpTool({ chatModelModalities: ['pdf'] })
    expect(schema.inputSchema.properties).toHaveProperty('modality')
    expect(
      (schema.inputSchema.properties as Record<string, { enum?: string[] }>)
        .modality?.enum,
    ).toEqual(['text', 'pdf'])
  })

  it('matches the still-live getLocalFileTools() projection for every modality case (drift guard)', () => {
    for (const modalities of [
      undefined,
      [] as const,
      ['vision'] as const,
      ['pdf'] as const,
      ['vision', 'pdf'] as const,
    ]) {
      const liveTool = getLocalFileTools({
        chatModelModalities: modalities ? [...modalities] : undefined,
      }).find((tool) => tool.name === 'fs_read')
      expect(liveTool).toBeDefined()

      const { name: _name, ...liveToolWithoutName } = liveTool!
      expect(
        fsReadDefinition.getMcpTool({
          chatModelModalities: modalities ? [...modalities] : undefined,
        }),
      ).toEqual(liveToolWithoutName)
    }
  })
})
