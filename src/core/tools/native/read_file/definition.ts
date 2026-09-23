import { type App, Platform } from 'obsidian'

import { buildImageCacheKey } from '../../../../database/local-cache/localCacheStore'
import type { YoloSettings } from '../../../../settings/schema/setting.types'
import type { ContentPart } from '../../../../types/llm/request'
import type { McpTool } from '../../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../../types/tool-call.types'
import { uint8ArrayToBase64 } from '../../../../utils/base64'
import {
  IMAGE_READ_MAX_BYTES,
  cachedImageDataUrl,
  getImageMimeTypeFromExtension,
  parseImageDataUrl,
} from '../../../../utils/llm/image'
import { chatModelSupportsVision } from '../../../../utils/llm/model-modalities'
import {
  PDF_READ_MAX_BYTES,
  PDF_READ_MAX_PAGES,
  extractPdfTextFromBase64,
} from '../../../../utils/pdf/extractPdfText'
import {
  buildAllowedSkillPathSet,
  normalizeExemptPath,
} from '../../../agent/workspaceScope'
import { MODULE_RENDERED_FILE_SOURCE_MAX_BYTES } from '../../../modules/moduleFileTextRendererRegistry'
import { getLiteSkillDocumentByPath } from '../../../skills/liteSkills'
import { defineTool } from '../../define'
import { sliceLines } from '../../line-slicing'
import { getVaultPathExtension } from '../../structured-vault-formats'
import {
  MAX_FILE_SIZE_BYTES,
  formatJsonResult,
  getOptionalBoundedIntegerArg,
  getTextArg,
} from '../../tool-args'
import {
  NATIVE_PATH_ARG_DESCRIPTION,
  getVaultBasePath,
  resolveNativePath,
  toEditSummaryPath,
} from '../paths'
import { assertDecodableAsText } from '../text'

const MAX_LINE_INDEX = 1_000_000

const READ_FILE_DESCRIPTION = [
  'Read a file straight from the local filesystem. Desktop-only.',
  '',
  'Also reads a skill from its path exactly as listed in <available_skills>. A file format a module renders (such as a whiteboard) comes back as that rendering, and `<file>#<fragment>` reads the part the module addresses by that fragment.',
  '',
  'Text files come back line-numbered with the total line count. Omit startLine/endLine to read the whole file; pass startLine (optionally with endLine) to read a window of a large one. A PDF is extracted to text and its line numbers are page numbers. An image is attached for the model to look at.',
].join('\n')

export const readFileDefinition = defineTool({
  name: 'read_file',
  summaryAction: 'read',
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
    const {
      app,
      settings,
      signal,
      chatModelId,
      allowedSkillPaths,
      resolveModuleFileTextRenderer,
    } = ctx

    const range = getReadRange(args)

    // A listed skill path is read through the skill registry, the same way
    // `fs_read` does: a builtin skill (`builtin://`) has no file on disk.
    const rawPath = getTextArg(args, 'path').trim()
    if (
      allowedSkillPaths &&
      buildAllowedSkillPathSet(allowedSkillPaths).has(
        normalizeExemptPath(rawPath),
      )
    ) {
      const skill = await getLiteSkillDocumentByPath({
        app,
        path: rawPath,
        settings,
      })
      if (!skill) {
        throw new Error(`Skill not found: ${rawPath}`)
      }
      return textResult({ path: rawPath, content: skill.content, range })
    }

    // A module-owned format reads as its module renders it, the same way
    // `fs_read` does, including the module's own `<file>#<fragment>`
    // addressing. The '#' splits only when the part before it has a
    // renderer, so a real file name containing '#' reads as itself.
    const hashIndex = rawPath.indexOf('#')
    const fragmentBase = hashIndex > 0 ? rawPath.slice(0, hashIndex) : null
    const fragmentRenderer =
      fragmentBase !== null
        ? resolveModuleFileTextRenderer?.(getVaultPathExtension(fragmentBase))
        : null
    const absolutePath = await resolveNativePath(
      app,
      fragmentRenderer && fragmentBase !== null ? fragmentBase : rawPath,
    )
    const fragment = fragmentRenderer ? rawPath.slice(hashIndex + 1) : undefined

    // eslint-disable-next-line import/no-nodejs-modules -- desktop-only tool, dynamically imported so mobile never loads it
    const fs = await import('node:fs/promises')
    const stat = await fs.stat(absolutePath)
    if (!stat.isFile()) {
      throw new Error(`Not a file: ${absolutePath}`)
    }

    const extension = getVaultPathExtension(absolutePath)

    const renderer =
      fragmentRenderer ?? resolveModuleFileTextRenderer?.(extension)
    if (renderer) {
      if (stat.size > MODULE_RENDERED_FILE_SOURCE_MAX_BYTES) {
        throw new Error(
          `File too large to render (${stat.size} bytes). Max source size for .${extension} is ${MODULE_RENDERED_FILE_SOURCE_MAX_BYTES} bytes.`,
        )
      }
      const displayPath = toEditSummaryPath(absolutePath, getVaultBasePath(app))
      const rendered = await renderer.render({
        path: displayPath,
        content: await fs.readFile(absolutePath, 'utf8'),
        ...(fragment !== undefined ? { fragment } : {}),
      })
      if (rendered.length > MAX_FILE_SIZE_BYTES) {
        throw new Error(
          `Rendered content too large (${rendered.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
        )
      }
      return textResult({ path: displayPath, content: rendered, range })
    }

    if (getImageMimeTypeFromExtension(extension)) {
      return readAsImage({
        app,
        absolutePath,
        extension,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        // A copy into a fresh Uint8Array: a Node Buffer can be a view into a
        // larger shared pool, so its `.buffer` is not the file's bytes alone.
        readBytes: async () =>
          new Uint8Array(await fs.readFile(absolutePath)).buffer,
        chatModelId,
        settings,
      })
    }

    if (extension === 'pdf') {
      if (stat.size > PDF_READ_MAX_BYTES) {
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
        maxPages: PDF_READ_MAX_PAGES,
        useCache: true,
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
    return textResult({
      path: absolutePath,
      content: new TextDecoder().decode(bytes),
      range,
    })
  },
})

const textResult = ({
  path,
  content,
  range,
}: {
  path: string
  content: string
  range: ReturnType<typeof getReadRange>
}) => {
  const lines = content.length === 0 ? [] : content.split('\n')
  const sliced = sliceLines(lines, range)
  return {
    status: ToolCallResponseStatus.Success as const,
    text: formatJsonResult({
      tool: 'read_file',
      path,
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
}

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

const readAsImage = async ({
  app,
  absolutePath,
  extension,
  sizeBytes,
  mtimeMs,
  readBytes,
  chatModelId,
  settings,
}: {
  app: App
  absolutePath: string
  extension: string
  sizeBytes: number
  mtimeMs: number
  readBytes: () => Promise<ArrayBuffer>
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
  if (sizeBytes > IMAGE_READ_MAX_BYTES) {
    throw new Error(
      `Image too large (${sizeBytes} bytes). Max allowed is ${IMAGE_READ_MAX_BYTES}.`,
    )
  }

  // Same encoding and cache as `fs_read`, so the image costs the same tokens
  // whichever tool read it, and the cache key lets the saved conversation
  // store a `cache://` reference instead of the whole data URL.
  const cacheKey = buildImageCacheKey(absolutePath, mtimeMs, sizeBytes)
  const dataUrl = await cachedImageDataUrl(app, {
    key: cacheKey,
    sourcePath: absolutePath,
    ext: extension,
    readBytes,
    compression: {
      enabled: settings?.chatOptions?.imageCompressionEnabled ?? true,
      quality: settings?.chatOptions?.imageCompressionQuality ?? 85,
    },
  })

  const parts: ContentPart[] = [
    { type: 'image_url', image_url: { url: dataUrl, cacheKey } },
  ]
  return {
    status: ToolCallResponseStatus.Success as const,
    text: formatJsonResult({
      tool: 'read_file',
      path: absolutePath,
      kind: 'image',
      // Compression can re-encode (PNG becomes JPEG), so report what is sent.
      mimeType: parseImageDataUrl(dataUrl).mimeType,
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
