import { Platform } from 'obsidian'

import type { YoloSettings } from '../../../../settings/schema/setting.types'
import type { ContentPart } from '../../../../types/llm/request'
import type { McpTool } from '../../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../../types/tool-call.types'
import { uint8ArrayToBase64 } from '../../../../utils/base64'
import { getImageMimeTypeFromExtension } from '../../../../utils/llm/image'
import { chatModelSupportsVision } from '../../../../utils/llm/model-modalities'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfTextFromBase64,
} from '../../../../utils/pdf/extractPdfText'
import { defineTool } from '../../define'
import { sliceLines } from '../../line-slicing'
import { getVaultPathExtension } from '../../structured-vault-formats'
import {
  MAX_FILE_SIZE_BYTES,
  formatJsonResult,
  getOptionalBoundedIntegerArg,
} from '../../tool-args'
import { NATIVE_PATH_ARG_DESCRIPTION, resolveNativeFilePathArg } from '../paths'
import { assertDecodableAsText } from '../text'

const MAX_LINE_INDEX = 1_000_000

const READ_FILE_DESCRIPTION = [
  'Read a file straight from the local filesystem. Desktop-only.',
  '',
  'Unrelated to fs_read: this never touches the Obsidian vault index, so it reads any extension, hidden directories, and paths outside the vault — but it also resolves no wikilinks, skills, or browser:// pages.',
  '',
  'Text files come back line-numbered with the total line count. Omit startLine/endLine to read the whole file; pass startLine (optionally with endLine) to read a window of a large one. A PDF is extracted to text and its line numbers are page numbers. An image is attached for the model to look at.',
].join('\n')

export const readFileDefinition = defineTool({
  name: 'read_file',
  getMcpTool: () =>
    ({
      description: READ_FILE_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: NATIVE_PATH_ARG_DESCRIPTION,
          },
          startLine: {
            type: 'integer',
            description:
              '1-based first line to return (PDF: first page). Omit together with endLine to read the whole file.',
          },
          endLine: {
            type: 'integer',
            description:
              '1-based inclusive last line to return (PDF: last page). Requires startLine.',
          },
        },
        required: ['path'],
      },
    }) satisfies Omit<McpTool, 'name'>,
  chatLabel: {
    key: 'settings.agent.builtinReadFileLabel',
    fallback: 'Read Local File',
  },
  contextPrunable: true,
  // Desktop-only for the same reason `terminal_command` is: `node:fs` does
  // not exist on mobile, so advertising this tool there would only produce
  // tool calls guaranteed to fail.
  isAvailable: () => Platform.isDesktop,
  filesystemPathArg: 'path',
  execute: async (args, ctx) => {
    const { app, settings, signal, chatModelId } = ctx

    const absolutePath = await resolveNativeFilePathArg(app, args)
    const range = getReadRange(args)

    // eslint-disable-next-line import/no-nodejs-modules -- desktop-only tool, dynamically imported so mobile never loads it
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${absolutePath}`)
    }

    const extension = getVaultPathExtension(absolutePath)

    const imageMimeType = getImageMimeTypeFromExtension(extension)
    if (imageMimeType) {
      return readAsImage({
        absolutePath,
        mimeType: imageMimeType,
        sizeBytes: stat.size,
        bytes: new Uint8Array(await fs.readFile(absolutePath)),
        chatModelId,
        settings,
      })
    }

    if (extension === 'pdf') {
      if (stat.size > PDF_INDEX_MAX_BYTES) {
        throw new Error(`PDF too large (${stat.size} bytes).`)
      }
      const base64 = uint8ArrayToBase64(
        new Uint8Array(await fs.readFile(absolutePath)),
      )
      // Same extraction (and the same shared page cache) `fs_read` uses for
      // vault PDFs — this call site just supplies the bytes itself rather
      // than a `TFile`.
      const { pages } = await extractPdfTextFromBase64(app, base64, {
        signal,
        maxPages: PDF_INDEX_MAX_PAGES,
        settings,
        sourceLabel: `native:${absolutePath}`,
      })
      return readPdfPages({ absolutePath, pages, range })
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(
        `File too large (${stat.size} bytes). Max allowed is ${MAX_FILE_SIZE_BYTES}. Read a line range, or narrow it with a shell command first.`,
      )
    }

    const bytes = new Uint8Array(await fs.readFile(absolutePath))
    assertDecodableAsText(bytes, absolutePath)
    const content = new TextDecoder().decode(bytes)
    const lines = content.length === 0 ? [] : content.split('\n')
    const sliced = sliceLines(lines, range)

    return {
      status: ToolCallResponseStatus.Success,
      text: formatJsonResult({
        tool: 'read_file',
        path: absolutePath,
        kind: 'text',
        totalLines: sliced.totalLines,
        returnedRange:
          range.type === 'lines'
            ? {
                startLine: sliced.returnedStartLine,
                endLine: sliced.returnedEndLine,
              }
            : undefined,
        hasMoreBelow: sliced.hasMoreBelow,
        nextStartLine: sliced.nextStartLine,
        content: sliced.outputContent,
      }),
    }
  },
})

const getReadRange = (
  args: Record<string, unknown>,
):
  | { type: 'full' }
  | { type: 'lines'; startLine: number; endLine?: number } => {
  const startLine = getOptionalBoundedIntegerArg({
    args,
    key: 'startLine',
    min: 1,
    max: MAX_LINE_INDEX,
  })
  const endLine = getOptionalBoundedIntegerArg({
    args,
    key: 'endLine',
    min: 1,
    max: MAX_LINE_INDEX,
  })
  if (startLine === undefined) {
    if (endLine !== undefined) {
      throw new Error('endLine requires startLine.')
    }
    return { type: 'full' }
  }
  if (endLine !== undefined && endLine < startLine) {
    throw new Error('endLine must be greater than or equal to startLine.')
  }
  return { type: 'lines', startLine, endLine }
}

const readAsImage = ({
  absolutePath,
  mimeType,
  sizeBytes,
  bytes,
  chatModelId,
  settings,
}: {
  absolutePath: string
  mimeType: string
  sizeBytes: number
  bytes: Uint8Array
  chatModelId?: string
  settings?: YoloSettings
}) => {
  // Same two gates `fs_read`'s image path applies: a text-only model would
  // 400 on the payload (issue #255), and the user-facing image-reading
  // switch turns the whole behavior off. Refusing loudly (rather than
  // silently returning nothing) is the honest answer for a file whose only
  // readable form is the image.
  const activeChatModel =
    chatModelId && settings?.chatModels
      ? (settings.chatModels.find((model) => model.id === chatModelId) ?? null)
      : null
  const modelAcceptsImages = activeChatModel
    ? chatModelSupportsVision(activeChatModel)
    : true
  if (!modelAcceptsImages) {
    throw new Error(
      `${absolutePath} is an image and the active chat model cannot accept image input.`,
    )
  }
  if (settings?.chatOptions?.imageReadingEnabled === false) {
    throw new Error(
      `${absolutePath} is an image, but image reading is turned off in settings.`,
    )
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Image too large (${sizeBytes} bytes). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
    )
  }

  const parts: ContentPart[] = [
    {
      type: 'image_url',
      image_url: {
        url: `data:${mimeType};base64,${uint8ArrayToBase64(bytes)}`,
      },
    },
  ]
  return {
    status: ToolCallResponseStatus.Success as const,
    text: formatJsonResult({
      tool: 'read_file',
      path: absolutePath,
      kind: 'image',
      mimeType,
      byteSize: sizeBytes,
      message: 'The image is attached after this tool result.',
    }),
    contentParts: parts,
  }
}

const readPdfPages = ({
  absolutePath,
  pages,
  range,
}: {
  absolutePath: string
  pages: { page: number; text: string }[]
  range:
    | { type: 'full' }
    | { type: 'lines'; startLine: number; endLine?: number }
}) => {
  const totalPages = pages.length
  // A page carries far more than a line, so an open-ended targeted read
  // returns the single requested page — matching `fs_read`'s PDF semantics
  // rather than its 50-line text default.
  const startPage = range.type === 'lines' ? range.startLine : 1
  const endPage =
    range.type === 'lines'
      ? Math.min(range.endLine ?? range.startLine, totalPages)
      : totalPages
  const selected = pages.filter(
    (page) => page.page >= startPage && page.page <= endPage,
  )
  const body = selected
    .map((page) => `<page ${page.page}>\n${page.text}\n</page ${page.page}>`)
    .join('\n')
  if (body.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Extracted PDF text too large (${body.length} chars). Read a narrower page range.`,
    )
  }
  const hasMoreBelow = endPage < totalPages
  return {
    status: ToolCallResponseStatus.Success as const,
    text: formatJsonResult({
      tool: 'read_file',
      path: absolutePath,
      kind: 'pdf',
      totalLines: totalPages,
      returnedRange:
        range.type === 'lines'
          ? {
              startLine: selected.length > 0 ? startPage : null,
              endLine: selected.length > 0 ? endPage : null,
            }
          : undefined,
      hasMoreBelow,
      nextStartLine: hasMoreBelow ? endPage + 1 : null,
      content: body,
    }),
  }
}
