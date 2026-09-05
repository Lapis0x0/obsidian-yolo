jest.mock('obsidian')

/* eslint-disable import/no-nodejs-modules -- real filesystem round-trip against a temp directory, see the file note below */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
/* eslint-enable import/no-nodejs-modules */

// The edit-summary tests below write a real edit review snapshot.
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { FileSystemAdapter } from 'obsidian'
import type { App } from 'obsidian'

import { readEditReviewSnapshot } from '../../../database/edit-review/editReviewSnapshotStore'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { editUndoSnapshotStore } from '../../../utils/chat/editUndoSnapshotStore'
import { executeBuiltinTool } from '../dispatcher'
import type { ToolContext } from '../types'

// Real filesystem, real temp directory: these three tools exist precisely to
// bypass every Obsidian abstraction, so a mocked fs would test nothing.

let vaultRoot: string
let outsideRoot: string
let ctx: ToolContext
let namespaceCounter = 0

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-native-files-'))
  vaultRoot = path.join(root, 'vault')
  outsideRoot = path.join(root, 'outside')
  await fs.mkdir(vaultRoot)
  await fs.mkdir(outsideRoot)

  globalThis.indexedDB = new IDBFactory()
  editUndoSnapshotStore.clear()
  namespaceCounter += 1
  const localStorage = new Map<string, string>([
    [
      'yolo-module-device-local-database-namespace',
      `00000000-0000-4000-8000-${String(namespaceCounter).padStart(12, '0')}`,
    ],
  ])

  const adapter = new FileSystemAdapter()
  adapter.getBasePath = () => vaultRoot
  ctx = {
    app: {
      vault: { adapter },
      loadLocalStorage: (key: string) => localStorage.get(key) ?? null,
      saveLocalStorage: (key: string, value: string) => {
        localStorage.set(key, value)
      },
    } as unknown as App,
  }
})

/** A chat context, so the write also produces a card and a review snapshot. */
const withChat = (overrides: Partial<ToolContext> = {}): void => {
  ctx = {
    ...ctx,
    conversationId: 'conv-1',
    roundId: 'round-1',
    toolCallId: 'call-1',
    ...overrides,
  }
}

const run = (name: string, args: Record<string, unknown>) =>
  executeBuiltinTool(name, args, ctx)

const expectSuccess = async (
  name: string,
  args: Record<string, unknown>,
): Promise<
  Extract<
    Awaited<ReturnType<typeof executeBuiltinTool>>,
    { status: ToolCallResponseStatus.Success }
  >
> => {
  const result = await run(name, args)
  if (result.status !== ToolCallResponseStatus.Success) {
    throw new Error(
      `expected success, got ${result.status}: ${JSON.stringify(result)}`,
    )
  }
  return result
}

const expectSuccessPayload = async (
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> =>
  JSON.parse((await expectSuccess(name, args)).text) as Record<string, unknown>

const expectError = async (
  name: string,
  args: Record<string, unknown>,
): Promise<string> => {
  const result = await run(name, args)
  if (result.status !== ToolCallResponseStatus.Error) {
    throw new Error(`expected error, got ${result.status}`)
  }
  return result.error
}

describe('read_file', () => {
  it('reads a whole text file with line numbers and a total line count', async () => {
    await fs.writeFile(path.join(vaultRoot, 'a.txt'), 'one\ntwo\nthree')

    const payload = await expectSuccessPayload('read_file', { path: 'a.txt' })

    expect(payload).toMatchObject({
      tool: 'read_file',
      path: path.join(vaultRoot, 'a.txt'),
      kind: 'text',
      totalLines: 3,
      hasMoreBelow: false,
      content: '1|one\n2|two\n3|three',
    })
  })

  it('reads a line window and reports what comes next', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    await fs.writeFile(path.join(vaultRoot, 'long.txt'), lines.join('\n'))

    const payload = await expectSuccessPayload('read_file', {
      path: 'long.txt',
      startLine: 3,
      endLine: 5,
    })

    expect(payload).toMatchObject({
      totalLines: 10,
      returnedRange: { startLine: 3, endLine: 5 },
      hasMoreBelow: true,
      nextStartLine: 6,
      content: '3|line 3\n4|line 4\n5|line 5',
    })
  })

  it('reads a file outside the vault by absolute path', async () => {
    const target = path.join(outsideRoot, 'secret.log')
    await fs.writeFile(target, 'outside')

    const payload = await expectSuccessPayload('read_file', { path: target })

    expect(payload).toMatchObject({ path: target, content: '1|outside' })
  })

  it('reads any extension, including a dotfile in a hidden directory', async () => {
    await fs.mkdir(path.join(vaultRoot, '.config'))
    await fs.writeFile(path.join(vaultRoot, '.config/.env'), 'KEY=value')

    const payload = await expectSuccessPayload('read_file', {
      path: '.config/.env',
    })

    expect(payload).toMatchObject({ content: '1|KEY=value' })
  })

  it('returns an image as an attached content part', async () => {
    // 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await fs.writeFile(path.join(vaultRoot, 'pixel.png'), png)

    const result = await run('read_file', { path: 'pixel.png' })
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(JSON.parse(result.text)).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    })
    expect(result.contentParts).toEqual([
      {
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${png.toString('base64')}` },
      },
    ])
  })

  it('refuses a binary file rather than emitting replacement characters', async () => {
    await fs.writeFile(
      path.join(vaultRoot, 'blob.bin'),
      Buffer.from([0x00, 0x01, 0x02]),
    )

    expect(await expectError('read_file', { path: 'blob.bin' })).toContain(
      'looks like a binary file',
    )
  })

  it('errors on a missing file and on a directory', async () => {
    expect(await expectError('read_file', { path: 'nope.txt' })).toContain(
      'ENOENT',
    )
    await fs.mkdir(path.join(vaultRoot, 'dir'))
    expect(await expectError('read_file', { path: 'dir' })).toContain(
      'Not a file',
    )
  })

  it('rejects endLine without startLine and an inverted range', async () => {
    await fs.writeFile(path.join(vaultRoot, 'a.txt'), 'x')
    expect(
      await expectError('read_file', { path: 'a.txt', endLine: 3 }),
    ).toContain('endLine requires startLine.')
    expect(
      await expectError('read_file', {
        path: 'a.txt',
        startLine: 5,
        endLine: 2,
      }),
    ).toContain('endLine must be greater than or equal to startLine.')
  })
})

describe('write_file', () => {
  it('creates a file and its missing parent directories', async () => {
    const payload = await expectSuccessPayload('write_file', {
      path: 'deep/nested/new.md',
      content: 'hello',
    })

    expect(payload).toMatchObject({
      tool: 'write_file',
      path: path.join(vaultRoot, 'deep/nested/new.md'),
      created: true,
      byteSize: 5,
    })
    await expect(
      fs.readFile(path.join(vaultRoot, 'deep/nested/new.md'), 'utf-8'),
    ).resolves.toBe('hello')
  })

  it('overwrites an existing file and reports it as not created', async () => {
    await fs.writeFile(path.join(vaultRoot, 'a.md'), 'old content')

    const payload = await expectSuccessPayload('write_file', {
      path: 'a.md',
      content: 'new',
    })

    expect(payload).toMatchObject({ created: false })
    expect(payload.message).toContain('Overwrote file')
    await expect(
      fs.readFile(path.join(vaultRoot, 'a.md'), 'utf-8'),
    ).resolves.toBe('new')
  })

  it('writes outside the vault by absolute path', async () => {
    const target = path.join(outsideRoot, 'out.txt')

    await expectSuccessPayload('write_file', { path: target, content: 'x' })

    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('x')
  })

  it('refuses a structured module-owned format', async () => {
    const error = await expectError('write_file', {
      path: 'board.yoloboard',
      content: '{}',
    })

    expect(error).toContain('yolo_whiteboard__edit_board')
    await expect(
      fs.stat(path.join(vaultRoot, 'board.yoloboard')),
    ).rejects.toThrow()
  })

  it('refuses to overwrite a directory', async () => {
    await fs.mkdir(path.join(vaultRoot, 'dir'))

    expect(
      await expectError('write_file', { path: 'dir', content: 'x' }),
    ).toContain('Path is a directory')
  })
})

describe('edit_file', () => {
  it('replaces a unique match and leaves the rest of the file alone', async () => {
    await fs.writeFile(path.join(vaultRoot, 'a.md'), 'alpha\nbeta\ngamma')

    const payload = await expectSuccessPayload('edit_file', {
      path: 'a.md',
      oldText: 'beta',
      newText: 'BETA',
    })

    expect(payload).toMatchObject({
      tool: 'edit_file',
      replacements: 1,
      changed: true,
    })
    await expect(
      fs.readFile(path.join(vaultRoot, 'a.md'), 'utf-8'),
    ).resolves.toBe('alpha\nBETA\ngamma')
  })

  it('refuses an ambiguous match and asks for more context', async () => {
    await fs.writeFile(path.join(vaultRoot, 'a.md'), 'x\nx\n')

    const error = await expectError('edit_file', {
      path: 'a.md',
      oldText: 'x',
      newText: 'y',
    })

    expect(error).toContain('must match exactly once')
    await expect(
      fs.readFile(path.join(vaultRoot, 'a.md'), 'utf-8'),
    ).resolves.toBe('x\nx\n')
  })

  it('gives the fs_edit-style hint when nothing matches', async () => {
    await fs.writeFile(path.join(vaultRoot, 'a.md'), 'alpha\n')

    const error = await expectError('edit_file', {
      path: 'a.md',
      oldText: 'nowhere',
      newText: 'y',
    })

    expect(error).toContain('Could not find the text to replace')
  })

  it('replaces every occurrence when replaceAll is true', async () => {
    await fs.writeFile(path.join(vaultRoot, 'a.md'), 'x\nx\nx\n')

    const payload = await expectSuccessPayload('edit_file', {
      path: 'a.md',
      oldText: 'x',
      newText: 'y',
      replaceAll: true,
    })

    expect(payload).toMatchObject({ replacements: 3 })
    await expect(
      fs.readFile(path.join(vaultRoot, 'a.md'), 'utf-8'),
    ).resolves.toBe('y\ny\ny\n')
  })

  it('errors on replaceAll with no match', async () => {
    await fs.writeFile(path.join(vaultRoot, 'a.md'), 'alpha\n')

    expect(
      await expectError('edit_file', {
        path: 'a.md',
        oldText: 'nowhere',
        newText: 'y',
        replaceAll: true,
      }),
    ).toContain('Could not find the text to replace')
  })

  it('does not create a missing file', async () => {
    expect(
      await expectError('edit_file', {
        path: 'missing.md',
        oldText: 'a',
        newText: 'b',
      }),
    ).toContain('ENOENT')
    await expect(fs.stat(path.join(vaultRoot, 'missing.md'))).rejects.toThrow()
  })

  it('refuses a structured module-owned format', async () => {
    await fs.writeFile(path.join(vaultRoot, 'board.yoloboard'), '{"a":1}')

    expect(
      await expectError('edit_file', {
        path: 'board.yoloboard',
        oldText: '1',
        newText: '2',
      }),
    ).toContain('yolo_whiteboard__edit_board')
  })

  it('edits a file outside the vault by absolute path', async () => {
    const target = path.join(outsideRoot, 'out.txt')
    await fs.writeFile(target, 'before')

    await expectSuccessPayload('edit_file', {
      path: target,
      oldText: 'before',
      newText: 'after',
    })

    await expect(fs.readFile(target, 'utf-8')).resolves.toBe('after')
  })
})

describe('native write tools produce edit summaries', () => {
  it('records a vault-relative path for a file inside the vault', async () => {
    withChat()
    await fs.writeFile(path.join(vaultRoot, 'note.md'), 'one\ntwo')

    const result = await expectSuccess('edit_file', {
      path: 'note.md',
      oldText: 'two',
      newText: 'two\nthree',
    })

    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 1,
      totalRemovedLines: 0,
      files: [{ path: 'note.md', operation: 'edit', undoStatus: 'available' }],
    })
    // 与 vault 版工具同形的相对路径，撤销/评审因此不需要额外分支。
    await expect(
      readEditReviewSnapshot({
        app: ctx.app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'note.md',
      }),
    ).resolves.toMatchObject({
      beforeContent: 'one\ntwo',
      afterContent: 'one\ntwo\nthree',
      contentAvailable: true,
    })
    expect(editUndoSnapshotStore.get('call-1', 'note.md')).toBeDefined()
  })

  it('records an absolute path for a file outside the vault', async () => {
    withChat()
    const target = path.join(outsideRoot, 'out.txt')
    await fs.writeFile(target, 'before')

    const result = await expectSuccess('edit_file', {
      path: target,
      oldText: 'before',
      newText: 'after',
    })

    expect(result.metadata?.editSummary).toMatchObject({
      files: [{ path: target }],
    })
    await expect(
      readEditReviewSnapshot({
        app: ctx.app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: target,
      }),
    ).resolves.toMatchObject({ afterContent: 'after' })
  })

  it('summarizes a replaceAll edit', async () => {
    withChat()
    await fs.writeFile(path.join(vaultRoot, 'note.md'), 'a\na\nb')

    const result = await expectSuccess('edit_file', {
      path: 'note.md',
      oldText: 'a',
      newText: 'c',
      replaceAll: true,
    })

    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      files: [{ path: 'note.md', addedLines: 2, removedLines: 2 }],
    })
  })

  it('summarizes a write_file creation as a create', async () => {
    withChat()

    const result = await expectSuccess('write_file', {
      path: 'sub/new.md',
      content: 'hello\nworld',
    })

    expect(result.metadata?.editSummary).toMatchObject({
      files: [{ path: 'sub/new.md', operation: 'create', addedLines: 2 }],
    })
    await expect(
      readEditReviewSnapshot({
        app: ctx.app,
        conversationId: 'conv-1',
        roundId: 'round-1',
        filePath: 'sub/new.md',
      }),
    ).resolves.toMatchObject({ beforeExists: false, afterExists: true })
  })

  it('summarizes a write_file overwrite against the previous content', async () => {
    withChat()
    await fs.writeFile(path.join(vaultRoot, 'note.md'), 'one\ntwo')

    const result = await expectSuccess('write_file', {
      path: 'note.md',
      content: 'one',
    })

    expect(result.metadata?.editSummary).toMatchObject({
      files: [{ path: 'note.md', operation: 'edit', removedLines: 1 }],
    })
  })

  it('skips the summary when the overwritten file is not text', async () => {
    withChat()
    await fs.writeFile(
      path.join(vaultRoot, 'blob.bin'),
      Buffer.from([0x00, 0x01, 0x02]),
    )

    const result = await expectSuccess('write_file', {
      path: 'blob.bin',
      content: 'text now',
    })

    // 写入照常发生，只是没法用一份按 UTF-8 解出来的「原文」建快照——
    // 撤销会把不是原来那些字节的内容写回去。
    expect(result.metadata?.editSummary).toBeUndefined()
    await expect(
      fs.readFile(path.join(vaultRoot, 'blob.bin'), 'utf-8'),
    ).resolves.toBe('text now')
  })
})
