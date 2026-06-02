jest.mock('obsidian')

jest.mock('../../utils/llm/extract-markdown-images', () => ({
  extractMarkdownImages: jest
    .fn()
    .mockResolvedValue({ contentParts: undefined }),
}))

// Mock pdf-lib for the native PDF slice tests below.
jest.mock('pdf-lib', () => {
  let _pageCount = 3
  const makeDoc = (pageCount: number) => ({
    getPageCount: () => pageCount,
    copyPages: jest.fn((_src: unknown, indices: number[]) =>
      Promise.resolve(indices.map(() => ({}))),
    ),
    addPage: jest.fn(),
    save: jest.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  })
  return {
    PDFDocument: {
      load: jest.fn(async () => makeDoc(_pageCount)),
      create: jest.fn(async () => makeDoc(0)),
      __setPageCount: (n: number) => {
        _pageCount = n
      },
    },
  }
})

// Mock slicePdfPages so we can control success/failure per test.
jest.mock('../../utils/pdf/slicePdfPages', () => ({
  PdfSliceError: class PdfSliceError extends Error {
    kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.name = 'PdfSliceError'
      this.kind = kind
    }
  },
  slicePdfPages: jest.fn(),
}))

import { App, TFile, TFolder } from 'obsidian'
import { PDFDocument } from 'pdf-lib'

import type { YoloSettings } from '../../settings/schema/setting.types'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import { editUndoSnapshotStore } from '../../utils/chat/editUndoSnapshotStore'
import { extractMarkdownImages } from '../../utils/llm/extract-markdown-images'
import { extractPdfText } from '../../utils/pdf/extractPdfText'
import { renderPdfPagesToImages } from '../../utils/pdf/renderPdfPagesToImages'
import { PdfSliceError, slicePdfPages } from '../../utils/pdf/slicePdfPages'
import type { RAGEngine } from '../rag/ragEngine'

import {
  callLocalFileTool,
  getLocalFileTools,
  isLocalFsWriteToolName,
  parseLocalFsActionFromToolArgs,
  recoverLikelyEscapedBackslashSequences,
} from './localFileTools'

afterEach(() => {
  editUndoSnapshotStore.clear()
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
        toolName: 'fs_delete',
        args: { path: 'tmp', recursive: true },
      }),
    ).toBe('delete')
  })

  it('recognizes write tool names with local prefixes', () => {
    expect(isLocalFsWriteToolName('fs_edit')).toBe(true)
    expect(isLocalFsWriteToolName('yolo_local__fs_move')).toBe(true)
    expect(isLocalFsWriteToolName('yolo_local__fs_read')).toBe(false)
  })

  it('routes fs_edit approval through apply review', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const modify = jest.fn()
    const read = jest.fn().mockResolvedValue('hello world')
    const openApplyReview = jest.fn().mockImplementation(async (state) => {
      state.callbacks?.onComplete?.({ finalContent: 'hello changed' })
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
      expect(result.error).toContain('fs_read')
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
      expect(result.error).toContain('fs_read')
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

  it('returns edit summary metadata for fs_delete (file)', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const read = jest.fn().mockResolvedValue(['one', 'two'].join('\n'))
    const trashFile = jest.fn()

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
        fileManager: {
          trashFile,
        },
      } as unknown as App,
      toolCallId: 'tool-call-delete-1',
      toolName: 'fs_delete',
      args: {
        path: 'note.md',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(trashFile).toHaveBeenCalledWith(file)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(result.metadata?.editSummary).toMatchObject({
      totalFiles: 1,
      totalAddedLines: 0,
      totalRemovedLines: 2,
      files: [{ operation: 'delete' }],
    })
    expect(
      editUndoSnapshotStore.get('tool-call-delete-1', 'note.md'),
    ).toMatchObject({
      beforeExists: true,
      afterExists: false,
    })
  })

  it('supports fs_read full operation', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const read = jest.fn().mockResolvedValue(['one', 'two', 'three'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
      } as unknown as App,
      toolCallId: 'read-call-1',
      toolName: 'fs_read',
      args: {
        paths: ['note.md'],
        operation: {
          type: 'full',
        },
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      toolCallId: string | null
      requestedOperation: { type: string; modality: string }
      results: Array<{
        ok: boolean
        content: string
        totalLines: number
        returnedRange?: { startLine: number | null; endLine: number | null }
      }>
    }
    expect(payload.toolCallId).toBe('read-call-1')
    expect(payload.requestedOperation).toMatchObject({
      type: 'full',
    })
    // modality omitted by caller → echoed as undefined / dropped from JSON.
    expect(payload.requestedOperation.modality).toBeUndefined()
    expect(payload.results[0]).toMatchObject({
      ok: true,
      content: ['1|one', '2|two', '3|three'].join('\n'),
      totalLines: 3,
    })
    expect(payload.results[0].returnedRange).toBeUndefined()
  })

  describe('fs_read image reading gating by chat model modalities', () => {
    const extractMock = extractMarkdownImages as jest.MockedFunction<
      typeof extractMarkdownImages
    >
    const buildSettings = (
      modalities: Array<'text' | 'vision'> | undefined,
    ): YoloSettings =>
      ({
        chatOptions: {
          imageReadingEnabled: true,
          imageCompressionEnabled: false,
          imageCompressionQuality: 85,
          externalImageFetchEnabled: false,
        },
        chatModels: [
          {
            id: 'provider/text-model',
            providerId: 'provider',
            model: 'text-model',
            modalities,
          },
        ],
      }) as unknown as YoloSettings

    const buildCallArgs = (settings: YoloSettings, modelId?: string) => {
      const file = Object.assign(new TFile(), {
        path: 'note.md',
        stat: { size: 64 },
      })
      return {
        app: {
          vault: {
            getFileByPath: jest.fn().mockReturnValue(file),
            read: jest.fn().mockResolvedValue('alpha\n![[img.png]]\nbeta'),
          },
        } as unknown as App,
        toolCallId: 'read-call',
        toolName: 'fs_read',
        args: {
          paths: ['note.md'],
          operation: { type: 'full' as const },
        },
        settings,
        chatModelId: modelId,
      }
    }

    beforeEach(() => {
      extractMock.mockReset()
      extractMock.mockResolvedValue({
        contentParts: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAA' },
          },
        ],
      } as unknown as Awaited<ReturnType<typeof extractMarkdownImages>>)
    })

    it('skips image extraction when the active model has declared text-only modalities', async () => {
      const settings = buildSettings(['text'])
      const result = await callLocalFileTool(
        buildCallArgs(settings, 'provider/text-model'),
      )

      expect(result.status).toBe(ToolCallResponseStatus.Success)
      expect(extractMock).not.toHaveBeenCalled()
      if (result.status === ToolCallResponseStatus.Success) {
        expect(result.contentParts).toBeUndefined()
      }
    })

    it('extracts images when the active model declares vision support', async () => {
      const settings = buildSettings(['text', 'vision'])
      const result = await callLocalFileTool(
        buildCallArgs(settings, 'provider/text-model'),
      )

      expect(result.status).toBe(ToolCallResponseStatus.Success)
      expect(extractMock).toHaveBeenCalledTimes(1)
    })

    it('defaults to text-only when the model has no modalities (should not happen post-migration)', async () => {
      const settings = buildSettings(undefined)
      const result = await callLocalFileTool(
        buildCallArgs(settings, 'provider/text-model'),
      )

      expect(result.status).toBe(ToolCallResponseStatus.Success)
      expect(extractMock).not.toHaveBeenCalled()
    })

    it('stays permissive when no chatModelId is passed (non-agent callers)', async () => {
      const settings = buildSettings(['text'])
      const result = await callLocalFileTool(buildCallArgs(settings, undefined))

      expect(result.status).toBe(ToolCallResponseStatus.Success)
      expect(extractMock).toHaveBeenCalledTimes(1)
    })
  })

  it('returns full fs_read content without internal character truncation', async () => {
    const longLine = 'a'.repeat(25_000)
    const file = Object.assign(new TFile(), {
      path: 'long-note.md',
      stat: { size: longLine.length },
    })
    const read = jest.fn().mockResolvedValue(longLine)

    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
      } as unknown as App,
      toolName: 'fs_read',
      args: {
        paths: ['long-note.md'],
        operation: {
          type: 'full',
        },
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    const payload = JSON.parse(result.text) as {
      requestedOperation: { type: string; modality: string }
      results: Array<{
        ok: boolean
        content: string
      }>
    }

    expect(payload.requestedOperation).toMatchObject({
      type: 'full',
    })
    expect(payload.requestedOperation.modality).toBeUndefined()
    expect(payload.results[0]).toMatchObject({
      ok: true,
      content: `1|${longLine}`,
    })
  })

  it('supports fs_read lines operation with numbered output', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 40 },
    })
    const read = jest
      .fn()
      .mockResolvedValue(['one', 'two', 'three', 'four'].join('\n'))

    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
      } as unknown as App,
      toolName: 'fs_read',
      args: {
        paths: ['note.md'],
        operation: {
          type: 'lines',
          startLine: 2,
          maxLines: 2,
        },
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    const payload = JSON.parse(result.text) as {
      toolCallId: string | null
      requestedOperation: { type: string; modality: string }
      results: Array<{
        ok: boolean
        content: string
        returnedRange?: { startLine: number | null; endLine: number | null }
        hasMoreBelow: boolean
        nextStartLine: number | null
      }>
    }
    expect(payload.toolCallId).toBeNull()
    expect(payload.requestedOperation).toEqual({
      type: 'lines',
    })
    expect(payload.results[0]).toMatchObject({
      ok: true,
      content: ['2|two', '3|three'].join('\n'),
      returnedRange: { startLine: 2, endLine: 3 },
      hasMoreBelow: true,
      nextStartLine: 4,
    })
  })

  it('rejects removed top-level fs_read line arguments', async () => {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })
    const read = jest.fn().mockResolvedValue('one\ntwo')

    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read,
        },
      } as unknown as App,
      toolName: 'fs_read',
      args: {
        paths: ['note.md'],
        startLine: 1,
        maxLines: 2,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain('operation must be a nested JSON object')
    }
  })

  describe('fs_read modality parsing', () => {
    const callRead = async (operation: unknown) => {
      const file = Object.assign(new TFile(), {
        path: 'note.md',
        stat: { size: 5 },
      })
      const read = jest.fn().mockResolvedValue('hello')
      return callLocalFileTool({
        app: {
          vault: {
            getFileByPath: jest.fn().mockReturnValue(file),
            read,
          },
        } as unknown as App,
        toolName: 'fs_read',
        args: { paths: ['note.md'], operation },
      })
    }

    const expectModality = (
      result: Awaited<ReturnType<typeof callRead>>,
      expected: 'text' | 'image' | undefined,
    ) => {
      expect(result.status).toBe(ToolCallResponseStatus.Success)
      if (result.status !== ToolCallResponseStatus.Success) {
        throw new Error('expected success')
      }
      const payload = JSON.parse(result.text) as {
        requestedOperation: { modality?: string }
      }
      // The echo is undefined / missing from JSON when the caller did not
      // provide a modality (default behavior). It only carries a value when
      // the caller explicitly opts into 'text' or 'image'.
      expect(payload.requestedOperation.modality).toBe(expected)
    }

    it('echoes undefined when modality is omitted', async () => {
      expectModality(await callRead({ type: 'full' }), undefined)
    })

    it('treats null / empty / whitespace-only modality as omitted', async () => {
      expectModality(
        await callRead({ type: 'full', modality: null }),
        undefined,
      )
      expectModality(
        await callRead({ type: 'full', modality: '   ' }),
        undefined,
      )
    })

    it('accepts modality case-insensitively and trims whitespace', async () => {
      expectModality(
        await callRead({ type: 'full', modality: 'IMAGE' }),
        'image',
      )
      expectModality(
        await callRead({ type: 'full', modality: '  Text  ' }),
        'text',
      )
    })

    it('rejects non-string modality values', async () => {
      const result = await callRead({ type: 'full', modality: 123 })
      expect(result.status).toBe(ToolCallResponseStatus.Error)
      if (result.status === ToolCallResponseStatus.Error) {
        expect(result.error).toMatch(/operation\.modality must be/)
      }
    })

    it("rejects unknown modality strings (including legacy 'auto')", async () => {
      // 'pdf' is intentionally NOT in this list — it's a valid value used by
      // the PDF-capable schema branch.
      for (const bad of ['video', 'auto', 'random-junk']) {
        const result = await callRead({ type: 'full', modality: bad })
        expect(result.status).toBe(ToolCallResponseStatus.Error)
        if (result.status === ToolCallResponseStatus.Error) {
          expect(result.error).toMatch(/operation\.modality must be/)
        }
      }
    })

    it('echoes modality back for non-PDF files even when image is requested', async () => {
      // Non-PDF files ignore modality at the rendering layer (no image branch
      // exists for .md), but the request payload still echoes what the model
      // asked for, so silent no-ops remain observable.
      expectModality(
        await callRead({ type: 'full', modality: 'image' }),
        'image',
      )
    })
  })

  it('defaults fs_search to hybrid and falls back to keyword with explicit reason', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      stat: { size: 20 },
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue([file]),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue([file]),
        },
      } as unknown as App,
      toolName: 'fs_search',
      args: {
        scope: 'files',
        query: 'note',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'fs_search',
      requestedMode: 'hybrid',
      effectiveMode: 'keyword',
      fallbackReason: 'Semantic search is not available in this context.',
      scope: 'files',
      query: 'note',
      path: '',
      results: [{ kind: 'file', path: 'note.md', source: 'keyword' }],
    })
  })

  it('keeps explicit rag strict when semantic search is unavailable', async () => {
    const root = Object.assign(new TFolder(), { path: '' })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
        },
      } as unknown as App,
      toolName: 'fs_search',
      args: {
        mode: 'rag',
        query: 'note',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toContain(
        'Semantic search is not available in this context.',
      )
    }
  })

  it('matches keyword file search by whitespace-separated tokens instead of full query string', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const files = [
      Object.assign(new TFile(), {
        path: '2.工作/3.工作流专项/1月/✅ 0109 Workflow 体系总览.md',
        stat: { size: 20 },
      }),
      Object.assign(new TFile(), {
        path: '2.工作/3.工作流专项/2月/✅ 0210 工作流复盘模块项目规划.md',
        stat: { size: 20 },
      }),
      Object.assign(new TFile(), {
        path: '2.工作/普通项目/普通笔记.md',
        stat: { size: 20 },
      }),
    ]

    const result = await callLocalFileTool({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue(files),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue(files),
        },
      } as unknown as App,
      toolName: 'fs_search',
      args: {
        mode: 'keyword',
        scope: 'files',
        query: 'workflow 工作流程 工作流',
        maxResults: 10,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toEqual({
      tool: 'fs_search',
      requestedMode: 'keyword',
      effectiveMode: 'keyword',
      scope: 'files',
      query: 'workflow 工作流程 工作流',
      path: '',
      results: [
        {
          kind: 'file',
          path: '2.工作/3.工作流专项/1月/✅ 0109 Workflow 体系总览.md',
          source: 'keyword',
        },
        {
          kind: 'file',
          path: '2.工作/3.工作流专项/2月/✅ 0210 工作流复盘模块项目规划.md',
          source: 'keyword',
        },
      ],
    })
  })

  it('ranks keyword content hits by matched token count before file path', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const fileA = Object.assign(new TFile(), {
      path: 'a.md',
      stat: { size: 200 },
    })
    const fileB = Object.assign(new TFile(), {
      path: 'b.md',
      stat: { size: 200 },
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue([fileA, fileB]),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue([fileA, fileB]),
          read: jest
            .fn()
            .mockImplementation(async (file: TFile) =>
              file.path === 'a.md'
                ? 'workflow 工作流 双命中'
                : '只有 workflow 单命中',
            ),
        },
      } as unknown as App,
      toolName: 'fs_search',
      args: {
        mode: 'keyword',
        scope: 'content',
        query: 'workflow 工作流',
        maxResults: 10,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toMatchObject({
      results: [
        {
          kind: 'content_group',
          path: 'a.md',
          hitCount: 1,
        },
        {
          kind: 'content_group',
          path: 'b.md',
          hitCount: 1,
        },
      ],
    })
  })

  it('aggregates hybrid content hits by file and keeps top snippets', async () => {
    const root = Object.assign(new TFolder(), { path: '' })
    const fileA = Object.assign(new TFile(), {
      path: 'workflow-a.md',
      stat: { size: 200 },
    })
    const fileB = Object.assign(new TFile(), {
      path: 'workflow-b.md',
      stat: { size: 200 },
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getRoot: jest.fn().mockReturnValue(root),
          getFiles: jest.fn().mockReturnValue([fileA, fileB]),
          getAllLoadedFiles: jest.fn().mockReturnValue([root]),
          getMarkdownFiles: jest.fn().mockReturnValue([fileA, fileB]),
          read: jest
            .fn()
            .mockImplementation(async (file: TFile) =>
              file.path === 'workflow-a.md'
                ? 'workflow intro\nother line\nworkflow appendix'
                : 'nothing relevant here',
            ),
        },
      } as unknown as App,
      settings: {
        ragOptions: {
          enabled: true,
          limit: 10,
        },
        embeddingModelId: 'test-embedding',
      } as unknown as YoloSettings,
      getRagEngine: async () =>
        ({
          processQuery: jest.fn().mockResolvedValue([
            {
              path: 'workflow-a.md',
              content: 'workflow intro chunk',
              metadata: { startLine: 1, endLine: 2 },
              similarity: 0.91,
            },
            {
              path: 'workflow-b.md',
              content: 'workflow b chunk',
              metadata: { startLine: 3, endLine: 4 },
              similarity: 0.89,
            },
            {
              path: 'workflow-a.md',
              content: 'workflow appendix chunk',
              metadata: { startLine: 10, endLine: 12 },
              similarity: 0.82,
            },
          ]),
        }) as unknown as RAGEngine,
      toolName: 'fs_search',
      args: {
        mode: 'hybrid',
        query: 'workflow',
        maxResults: 10,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }

    expect(JSON.parse(result.text)).toMatchObject({
      tool: 'fs_search',
      requestedMode: 'hybrid',
      effectiveMode: 'hybrid',
      scope: 'content',
      query: 'workflow',
      path: '',
      results: [
        {
          kind: 'content_group',
          path: 'workflow-a.md',
          source: 'hybrid',
          hitCount: 2,
          snippets: [
            { startLine: 1, endLine: 2 },
            { startLine: 10, endLine: 12 },
          ],
        },
        {
          kind: 'content_group',
          path: 'workflow-b.md',
          source: 'hybrid',
          hitCount: 1,
          snippets: [{ startLine: 3, endLine: 4 }],
        },
      ],
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

  it('deletes a folder via fs_delete with recursive and reports targetKind', async () => {
    const child = Object.assign(new TFile(), {
      path: 'docs/a.md',
      stat: { size: 1 },
    })
    const folder = Object.assign(new TFolder(), {
      path: 'docs',
      children: [child],
    })
    const trashFile = jest.fn()

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(folder),
        },
        fileManager: { trashFile },
      } as unknown as App,
      toolName: 'fs_delete',
      args: {
        path: 'docs',
        recursive: true,
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    expect(trashFile).toHaveBeenCalledWith(folder)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    // Folder deletions carry no editSummary / chat-undo snapshot.
    expect(result.metadata).toBeUndefined()
    expect(JSON.parse(result.text)).toMatchObject({
      tool: 'fs_delete',
      action: 'delete',
      results: [{ ok: true, target: 'docs', targetKind: 'folder' }],
    })
  })

  it('refuses to delete a non-empty folder without recursive', async () => {
    const child = Object.assign(new TFile(), {
      path: 'docs/a.md',
      stat: { size: 1 },
    })
    const folder = Object.assign(new TFolder(), {
      path: 'docs',
      children: [child],
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(folder),
        },
        fileManager: { trashFile: jest.fn() },
      } as unknown as App,
      toolName: 'fs_delete',
      args: { path: 'docs' },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toMatch(/not empty/i)
    }
  })

  it('returns Error when a single fs_move target fails', async () => {
    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest.fn().mockReturnValue(null),
          createFolder: jest.fn(),
        },
        fileManager: { renameFile: jest.fn() },
      } as unknown as App,
      toolName: 'fs_move',
      args: {
        oldPath: 'docs/missing.md',
        newPath: 'docs/missing-renamed.md',
      },
    })

    expect(result.status).toBe(ToolCallResponseStatus.Error)
    if (result.status === ToolCallResponseStatus.Error) {
      expect(result.error).toBe('Source path not found: docs/missing.md')
    }
  })

  it('keeps fs write tool schemas flat without items or top-level combinators', () => {
    const tools = getLocalFileTools()
    const schemaByName = new Map(
      tools.map((tool) => [tool.name, tool.inputSchema] as const),
    )

    const expectedRequired: Record<string, string[]> = {
      fs_write: ['path', 'content'],
      fs_delete: ['path'],
      fs_create_dir: ['path'],
      fs_move: ['oldPath', 'newPath'],
    }

    for (const [toolName, required] of Object.entries(expectedRequired)) {
      const schema = schemaByName.get(toolName) as
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
      expect(schema?.required).toEqual(required)
      expect(schema?.oneOf).toBeUndefined()
      expect(schema?.anyOf).toBeUndefined()
      expect(schema?.allOf).toBeUndefined()
    }
  })

  it('creates missing parent folders before creating a directory', async () => {
    const entries = new Map<string, unknown>()
    const createFolder = jest.fn().mockImplementation(async (path: string) => {
      const folder = Object.assign(new TFolder(), {
        path,
        children: [],
      })
      entries.set(path, folder)
      return folder
    })

    const result = await callLocalFileTool({
      app: {
        vault: {
          getAbstractFileByPath: jest
            .fn()
            .mockImplementation((path: string) => entries.get(path) ?? null),
          createFolder,
        },
      } as unknown as App,
      toolName: 'fs_create_dir',
      args: {
        path: '99-Assets/YOLO/skills/content-organization',
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

// ──────────────────────────────────────────────────────────────────
// fs_read modality schema is tailored per active chat model capability
// ──────────────────────────────────────────────────────────────────

describe('fs_read modality schema is tailored per model capability', () => {
  type FsReadInputSchema = {
    properties?: {
      operation?: {
        properties?: {
          modality?: {
            type?: string
            enum?: string[]
            description?: string
          }
        }
      }
    }
  }
  const getModalitySchema = (modalities?: Array<'text' | 'vision' | 'pdf'>) => {
    const tools = getLocalFileTools({ chatModelModalities: modalities })
    const fsRead = tools.find((t) => t.name === 'fs_read')
    if (!fsRead) throw new Error('fs_read not found')
    const schema = fsRead.inputSchema as FsReadInputSchema
    return schema.properties?.operation?.properties?.modality
  }

  it('exposes the full superset (text/image/pdf) when no model context is passed', () => {
    // The UI / persistence call sites use this branch so the user-facing
    // permission editor can show every possible modality independent of
    // which model happens to be active.
    const modality = getModalitySchema(undefined)
    expect(modality).toBeDefined()
    expect(modality?.enum).toEqual(['text', 'image', 'pdf'])
  })

  it("PDF-capable model: enum is ['text', 'pdf']; image is NOT exposed", () => {
    // Image is meaningless on PDF-capable models — native PDF strictly
    // dominates. Removing it from the enum makes the wrong choice
    // structurally unrepresentable.
    const modality = getModalitySchema(['text', 'vision', 'pdf'])
    expect(modality).toBeDefined()
    expect(modality?.enum).toEqual(['text', 'pdf'])
    expect(modality?.enum).not.toContain('image')
  })

  it("vision-capable (non-PDF) model: enum is ['text', 'image']; pdf is NOT exposed", () => {
    // pdf is meaningless without native PDF support. Image is the
    // legitimate visual workaround in this case.
    const modality = getModalitySchema(['text', 'vision'])
    expect(modality).toBeDefined()
    expect(modality?.enum).toEqual(['text', 'image'])
    expect(modality?.enum).not.toContain('pdf')
  })

  it('text-only model: modality field is omitted from the schema entirely', () => {
    // No override is meaningful — every path collapses to text. The
    // cleanest signal to the model is to not show the field at all.
    expect(getModalitySchema(['text'])).toBeUndefined()
  })

  it('pdf-only (hypothetical, no vision) model: enum still excludes image', () => {
    // Defensive: even a model declared pdf-capable but not vision-capable
    // should never see image as a choice.
    const modality = getModalitySchema(['text', 'pdf'])
    expect(modality?.enum).toEqual(['text', 'pdf'])
  })
})

// ──────────────────────────────────────────────────────────────────
// fs_read PDF vision-downgrade warning
// ──────────────────────────────────────────────────────────────────

jest.mock('../../utils/pdf/extractPdfText', () => ({
  PDF_INDEX_MAX_BYTES: 50 * 1024 * 1024,
  PDF_INDEX_MAX_PAGES: 500,
  extractPdfText: jest.fn(),
}))

jest.mock('../../utils/pdf/renderPdfPagesToImages', () => ({
  renderPdfPagesToImages: jest.fn(),
}))

describe('fs_read PDF vision-downgrade warning', () => {
  const extractMock = extractPdfText as jest.MockedFunction<
    typeof extractPdfText
  >
  const renderMock = renderPdfPagesToImages as jest.MockedFunction<
    typeof renderPdfPagesToImages
  >

  const makePdfFile = () =>
    Object.assign(new TFile(), {
      path: 'doc.pdf',
      extension: 'pdf',
      stat: { size: 1024, mtime: 0 },
    })

  const buildSettings = (modalities: Array<'text' | 'vision'>): YoloSettings =>
    ({
      chatOptions: {
        imageReadingEnabled: true,
        imageCompressionEnabled: false,
        imageCompressionQuality: 85,
        externalImageFetchEnabled: false,
      },
      chatModels: [
        {
          id: 'provider/model',
          providerId: 'provider',
          model: 'model',
          modalities,
        },
      ],
    }) as unknown as YoloSettings

  beforeEach(() => {
    extractMock.mockReset()
    renderMock.mockReset()
    extractMock.mockResolvedValue({
      pages: [
        { page: 1, text: 'page one content' },
        { page: 2, text: 'page two content' },
      ],
    })
    renderMock.mockResolvedValue({
      totalPages: 2,
      rendered: [{ page: 1, dataUrl: 'data:image/png;base64,AAA' }],
    } as unknown as Awaited<ReturnType<typeof renderPdfPagesToImages>>)
  })

  const callPdfRead = (
    modality: 'text' | 'image',
    modalities: Array<'text' | 'vision'>,
  ) => {
    const file = makePdfFile()
    return callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read: jest.fn().mockResolvedValue(''),
        },
      } as unknown as App,
      toolName: 'fs_read',
      toolCallId: 'tc-pdf',
      args: {
        paths: ['doc.pdf'],
        operation: { type: 'full', modality },
      },
      settings: buildSettings(modalities),
      chatModelId: 'provider/model',
    })
  }

  it('adds effectiveModality and warning when modality=image but model is text-only', async () => {
    const result = await callPdfRead('image', ['text'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')
    // Should have fallen back to text extraction
    expect(extractMock).toHaveBeenCalled()
    expect(renderMock).not.toHaveBeenCalled()
    const payload = JSON.parse(result.text) as {
      results: Array<{
        effectiveModality?: string
        warning?: string
      }>
    }
    expect(payload.results[0]?.effectiveModality).toBe('text')
    expect(payload.results[0]?.warning).toBe(
      '当前模型不支持图像输入，已自动降级为文本读取',
    )
  })

  it('does NOT add effectiveModality/warning when modality=image and model supports vision', async () => {
    const result = await callPdfRead('image', ['text', 'vision'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')
    // Should have taken image path
    expect(renderMock).toHaveBeenCalled()
    expect(extractMock).not.toHaveBeenCalled()
    // Image path builds a separate results entry without these fields
    const payload = JSON.parse(result.text) as {
      results: Array<{
        effectiveModality?: string
        warning?: string
      }>
    }
    expect(payload.results[0]?.effectiveModality).toBeUndefined()
    expect(payload.results[0]?.warning).toBeUndefined()
  })

  it('does NOT add effectiveModality/warning when modality=text regardless of model', async () => {
    const result = await callPdfRead('text', ['text'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')
    const payload = JSON.parse(result.text) as {
      results: Array<{
        effectiveModality?: string
        warning?: string
      }>
    }
    expect(payload.results[0]?.effectiveModality).toBeUndefined()
    expect(payload.results[0]?.warning).toBeUndefined()
  })
})

// fs_read PDF native slice (default modality + explicit overrides)
// ──────────────────────────────────────────────────────────────────

describe('fs_read PDF native slice', () => {
  const sliceMock = slicePdfPages as jest.MockedFunction<typeof slicePdfPages>
  const extractMockNative = extractPdfText as jest.MockedFunction<
    typeof extractPdfText
  >
  const pdfLibMock = PDFDocument as unknown as {
    load: jest.Mock
    create: jest.Mock
    __setPageCount: (n: number) => void
  }

  const makePdfFile = () =>
    Object.assign(new TFile(), {
      path: 'report.pdf',
      extension: 'pdf',
      name: 'report.pdf',
      stat: { size: 4096, mtime: 0 },
    })

  const buildSettings = (
    modalities: Array<'text' | 'vision' | 'pdf'>,
  ): YoloSettings =>
    ({
      chatOptions: {
        imageReadingEnabled: true,
        imageCompressionEnabled: false,
        imageCompressionQuality: 85,
        externalImageFetchEnabled: false,
      },
      chatModels: [
        {
          id: 'provider/model',
          providerId: 'provider',
          model: 'model',
          modalities,
        },
      ],
    }) as unknown as YoloSettings

  const FAKE_PDF_BYTES = new Uint8Array([1, 2, 3, 4])

  beforeEach(() => {
    jest.clearAllMocks()
    pdfLibMock.__setPageCount(5)
    sliceMock.mockImplementation(async (_bytes, range) => ({
      bytes: FAKE_PDF_BYTES,
      totalSourcePages: 5,
      actualStart: range.startPage,
      actualEnd: range.endPage !== undefined ? Math.min(range.endPage, 5) : 5,
    }))
    extractMockNative.mockResolvedValue({
      pages: [
        { page: 1, text: 'page one' },
        { page: 2, text: 'page two' },
        { page: 3, text: 'page three' },
      ],
    })
  })

  // `modality` may be:
  //   • undefined → omitted from the request, exercising default behavior
  //   • 'text' / 'image' / 'pdf' → explicit caller override
  // The schema exposed to the model is tailored per capability, but the
  // parser still accepts the full superset for resilience (see resolver
  // safety-net tests near the bottom of this describe block).
  // Legacy value 'auto' is not accepted — see the dedicated rejection test.
  const callPdfSliceRead = (
    modality: 'text' | 'image' | 'pdf' | undefined,
    modalities: Array<'text' | 'vision' | 'pdf'>,
    operationType: 'full' | 'lines' = 'lines',
    startLine = 1,
    endLine = 2,
  ) => {
    const file = makePdfFile()
    const baseOp =
      operationType === 'full'
        ? { type: 'full' as const }
        : { type: 'lines' as const, startLine, endLine }
    const operation = modality === undefined ? baseOp : { ...baseOp, modality }
    return callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read: jest.fn().mockResolvedValue(''),
          readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
        },
      } as unknown as App,
      toolName: 'fs_read',
      toolCallId: 'tc-pdf-native',
      args: {
        paths: ['report.pdf'],
        operation,
      },
      settings: buildSettings(modalities),
      chatModelId: 'provider/model',
    })
  }

  it('no modality + pdf-capable model → takes native pdf path with original page range in name', async () => {
    // Default behavior (modality omitted): the runtime decides based on the
    // active model's capabilities. With a PDF-capable model this MUST land on
    // the native pdf slice path — that's the whole point of leaving it unset.
    const result = await callPdfSliceRead(undefined, ['text', 'vision', 'pdf'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    expect(sliceMock).toHaveBeenCalled()
    expect(result.contentParts).toBeDefined()
    expect(result.contentParts).toHaveLength(1)
    const part = result.contentParts![0]
    expect(part?.type).toBe('document')
    if (part?.type !== 'document') throw new Error('expected document part')
    expect(part.name).toContain('pages 1')
    expect(part.name).toContain('2')

    // text field should explain page renumbering
    const payload = JSON.parse(result.text) as {
      results: Array<{ content: string; effectiveModality?: string }>
    }
    expect(payload.results[0]?.content).toContain('ORIGINAL page numbers')
    expect(payload.results[0]?.effectiveModality).toBe('pdf')
  })

  it('no modality + vision-only model → takes text path (image is NEVER auto-selected)', async () => {
    // Regression guard for the auto-priority fix: previously the default
    // resolved to `pdf > image > text`, silently rendering every page to a
    // PNG for any vision-capable model — extremely expensive and almost
    // never what the caller wants. The new contract is `pdf > text`; image
    // must be opted into explicitly via modality:'image'.
    const renderMock = renderPdfPagesToImages as jest.MockedFunction<
      typeof renderPdfPagesToImages
    >

    const result = await callPdfSliceRead(undefined, ['text', 'vision'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    expect(sliceMock).not.toHaveBeenCalled()
    expect(renderMock).not.toHaveBeenCalled()
    expect(extractMockNative).toHaveBeenCalled()
    // No document/image parts expected — text is returned inline as result.text
    const docParts = (result.contentParts ?? []).filter(
      (p) => p.type === 'document',
    )
    expect(docParts).toHaveLength(0)
  })

  it('no modality + text-only model → takes text path', async () => {
    const result = await callPdfSliceRead(undefined, ['text'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    expect(sliceMock).not.toHaveBeenCalled()
    expect(extractMockNative).toHaveBeenCalled()
    expect(result.contentParts).toBeUndefined()
  })

  it('no chatModelId → default modality does NOT take pdf path (conservative fallback)', async () => {
    const file = makePdfFile()
    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
        },
      } as unknown as App,
      toolName: 'fs_read',
      toolCallId: 'tc-no-model',
      args: {
        paths: ['report.pdf'],
        operation: {
          type: 'lines',
          startLine: 1,
          endLine: 2,
          // modality intentionally omitted
        },
      },
      // No settings / chatModelId supplied
    })
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    // slicePdfPages should NOT have been called
    expect(sliceMock).not.toHaveBeenCalled()
  })

  it('slice fails (PdfSliceError) → falls back to text, warning present', async () => {
    sliceMock.mockRejectedValueOnce(
      new PdfSliceError('load-failed', 'encrypted PDF'),
    )

    const result = await callPdfSliceRead(undefined, ['text', 'vision', 'pdf'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    expect(extractMockNative).toHaveBeenCalled()
    const payload = JSON.parse(result.text) as {
      results: Array<{ content: string; effectiveModality?: string }>
    }
    expect(payload.results[0]?.content).toContain('PDF native slice failed')
    expect(payload.results[0]?.content).toContain('encrypted PDF')
    expect(payload.results[0]?.effectiveModality).toBe('text')
  })

  // ── Bug fix tests ──────────────────────────────────────────────────

  it('full read + slice failure on pdf path → fallback returns all pages (bug 1)', async () => {
    // extractMock returns 3 pages; slice fails → fallback should cover all 3
    sliceMock.mockRejectedValueOnce(
      new PdfSliceError('load-failed', 'corrupt PDF'),
    )

    const result = await callPdfSliceRead(
      undefined,
      ['text', 'vision', 'pdf'],
      'full',
    )
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    expect(extractMockNative).toHaveBeenCalled()
    const payload = JSON.parse(result.text) as {
      results: Array<{ content: string; effectiveModality?: string }>
    }
    const content = payload.results[0]?.content ?? ''
    // All 3 pages must appear in fallback content
    expect(content).toContain('page one')
    expect(content).toContain('page two')
    expect(content).toContain('page three')
  })

  it('lines read without endLine on pdf path → returns single page (bug 2)', async () => {
    const file = makePdfFile()
    const result = await callLocalFileTool({
      app: {
        vault: {
          getFileByPath: jest.fn().mockReturnValue(file),
          read: jest.fn().mockResolvedValue(''),
          readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(4)),
        },
      } as unknown as App,
      toolName: 'fs_read',
      toolCallId: 'tc-no-endline',
      args: {
        paths: ['report.pdf'],
        operation: {
          type: 'lines',
          startLine: 2,
          // endLine and modality intentionally omitted
        },
      },
      settings: buildSettings(['text', 'vision', 'pdf']),
      chatModelId: 'provider/model',
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    // slicePdfPages should have been called with only page 2 (startPage = endPage = 2)
    expect(sliceMock).toHaveBeenCalledWith(expect.any(Uint8Array), {
      startPage: 2,
      endPage: 2,
    })
  })

  it('page count >100 on pdf path → PdfSliceError → fallback returns all pages (bug 1)', async () => {
    // Set pdf-lib to report 150 pages; sliceMock throws because >MAX_SLICE_PAGES
    pdfLibMock.__setPageCount(150)
    extractMockNative.mockResolvedValueOnce({
      pages: Array.from({ length: 150 }, (_, i) => ({
        page: i + 1,
        text: `page ${i + 1} content`,
      })),
    })
    sliceMock.mockRejectedValueOnce(
      new PdfSliceError(
        'too-many-pages',
        'Requested 150 pages but the maximum allowed per slice is 100.',
      ),
    )

    const result = await callPdfSliceRead(
      undefined,
      ['text', 'vision', 'pdf'],
      'full',
    )
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    expect(extractMockNative).toHaveBeenCalled()
    const payload = JSON.parse(result.text) as {
      results: Array<{ content: string; totalLines?: number }>
    }
    // totalLines should reflect all 150 pages
    expect(payload.results[0]?.totalLines).toBe(150)
    // Content must include the last page
    expect(payload.results[0]?.content).toContain('page 150 content')
  })

  it('invalid-range PdfSliceError → ok:false hard error, no text fallback', async () => {
    // Caller asked for a page outside the document — must surface as a model
    // error rather than silently degrade to text.
    sliceMock.mockRejectedValueOnce(
      new PdfSliceError(
        'invalid-range',
        "startPage 999 exceeds the source document's 5 pages.",
      ),
    )

    const result = await callPdfSliceRead(undefined, ['text', 'vision', 'pdf'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    // Text extraction must NOT have run.
    expect(extractMockNative).not.toHaveBeenCalled()

    const payload = JSON.parse(result.text) as {
      results: Array<{ ok: boolean; error?: string }>
    }
    expect(payload.results[0]?.ok).toBe(false)
    expect(payload.results[0]?.error).toContain('exceeds')
  })

  // ── Strict modality rejection (regression guard) ──────────────────────
  // Legacy 'auto' was removed when we simplified the schema. The parser
  // must hard-reject it rather than silently coerce — silent acceptance
  // would let the deprecated value live forever in tool-call contexts.
  // 'pdf' was reinstated as a valid value (used by the PDF-capable
  // schema) and is intentionally NOT in this rejection list.

  it.each([['auto'], ['video'], ['random-junk']])(
    "modality='%s' is rejected as invalid input",
    async (invalidValue) => {
      const file = makePdfFile()
      const result = await callLocalFileTool({
        app: {
          vault: { getFileByPath: jest.fn().mockReturnValue(file) },
        } as unknown as App,
        toolName: 'fs_read',
        toolCallId: 'tc-invalid-modality',
        args: {
          paths: ['report.pdf'],
          operation: { type: 'full', modality: invalidValue },
        },
        settings: buildSettings(['text', 'vision', 'pdf']),
        chatModelId: 'provider/model',
      })

      expect(result.status).toBe(ToolCallResponseStatus.Error)
      if (result.status !== ToolCallResponseStatus.Error)
        throw new Error('expected error')
      expect(result.error).toMatch(/modality/i)
    },
  )

  // ── Out-of-schema safety net ─────────────────────────────────────────
  // The schema exposed to the model is tailored per capability, so e.g.
  // PDF-capable models normally don't see 'image' as an option. But if a
  // model somehow sends an out-of-schema modality value (stale tool-call
  // history, copy-paste from another conversation, etc.), the resolver
  // maps it to the strictly-better alternative instead of failing.

  it("modality='image' on PDF-capable model → resolves to native PDF (safety-net upgrade)", async () => {
    // The PDF-capable schema doesn't expose 'image' to the model, so
    // landing here means the value came in via some unintended channel.
    // We resolve to native PDF because it strictly dominates image on
    // PDF-capable models — image was only ever a workaround for models
    // lacking native PDF support.
    const result = await callPdfSliceRead('image', ['text', 'vision', 'pdf'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    expect(sliceMock).toHaveBeenCalled()
    expect(result.contentParts?.[0]?.type).toBe('document')
    const payload = JSON.parse(result.text) as {
      results: Array<{ effectiveModality?: string }>
    }
    expect(payload.results[0]?.effectiveModality).toBe('pdf')
  })

  it("modality='pdf' on vision-only model → resolves to text with effectiveModality marker (safety-net downgrade)", async () => {
    // pdf is not exposed in the vision-only schema; if it leaks through,
    // there's no way to honor it, so fall back to text. The result is
    // marked with effectiveModality so log readers can see requested vs
    // executed diverged — no model-visible warning text is attached,
    // because this is the system's choice, not something the model should
    // try to "correct" by retrying with a different modality.
    const result = await callPdfSliceRead('pdf', ['text', 'vision'])
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success)
      throw new Error('expected success')

    expect(sliceMock).not.toHaveBeenCalled()
    expect(extractMockNative).toHaveBeenCalled()

    const payload = JSON.parse(result.text) as {
      results: Array<{ effectiveModality?: string; warning?: string }>
    }
    expect(payload.results[0]?.effectiveModality).toBe('text')
    expect(payload.results[0]?.warning).toBeUndefined()
  })
})
