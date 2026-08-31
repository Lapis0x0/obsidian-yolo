import { Platform } from 'obsidian'

import { buildPdfPageImageCacheKey } from '../../../database/json/chat/imageCacheStore'
import type { ContentPart } from '../../../types/llm/request'
import type { McpTool } from '../../../types/mcp.types'
import {
  ToolCallResponseStatus,
  type ToolFsReadOperationSummary,
} from '../../../types/tool-call.types'
import { uint8ArrayToBase64 } from '../../../utils/base64'
import { collectWikilinkPaths } from '../../../utils/llm/annotate-wikilinks'
import { extractMarkdownImages } from '../../../utils/llm/extract-markdown-images'
import {
  chatModelSupportsPdf,
  chatModelSupportsVision,
} from '../../../utils/llm/model-modalities'
import {
  type WikilinkReadSubpath,
  resolveWikilinkReadTarget,
} from '../../../utils/llm/resolve-wikilink-target'
import { parseOfficeDocument } from '../../../utils/office'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfText,
} from '../../../utils/pdf/extractPdfText'
import { renderPdfPagesToImages } from '../../../utils/pdf/renderPdfPagesToImages'
import { PdfSliceError, slicePdfPages } from '../../../utils/pdf/slicePdfPages'
import {
  buildAllowedSkillPathSet,
  describePathDenial,
  normalizeSkillPathForExemption,
  resolvePathVisibility,
} from '../../agent/workspaceScope'
import { findWebviewHandleByPageId } from '../../browser/activeWebviewProbe'
import {
  BrowserReadFailure,
  readActiveWebviewPage,
} from '../../browser/activeWebviewReader'
import { validateVaultPath } from '../../mcp/vaultFileOps'
import { getLiteSkillDocumentByPath } from '../../skills/liteSkills'
import { defineTool } from '../define'
import {
  MAX_FILE_SIZE_BYTES,
  formatJsonResult,
  getOptionalTextArg,
  getStringArrayArg,
} from '../tool-args'

import {
  type FsReadOperation,
  MAX_BATCH_READ_FILES,
  MAX_READ_MAX_LINES,
  OFFICE_READ_MAX_BYTES,
  buildFsReadModalitySchema,
  getFsReadOperation,
  getOfficeDocumentKindFromExtension,
  isBrowserReadPath,
  normalizeFsReadPath,
  parseBrowserReadPageId,
  sliceLinesForFsReadOperation,
} from './schema-helpers'

// Base schema fields copied verbatim from the `fs_read` entry in
// `getLocalFileTools()` (`src/core/mcp/localFileTools.ts:820`), minus the
// `modality` field — that one is dynamic (see `getMcpTool` below).
//
// Built lazily inside a function, NOT as a module-level `const`. This
// originally guarded against a real bug: an earlier version of the D6
// delegation bridge created a cycle back through `localFileTools.ts`, and a
// module-level `const` referencing `MAX_BATCH_READ_FILES` at import time
// could observe that binding before its defining module had finished
// initializing, silently baking `undefined` into the schema text. That
// specific cycle no longer exists (D6a fix — `MAX_BATCH_READ_FILES` now
// comes from the sibling `./schema-helpers` module, not `localFileTools.ts`),
// but deferring the read to call time has no downside and guards against the
// same class of module-init-order hazard should another cycle appear later,
// so it stays.
const buildFsReadBaseSchemaProperties = () =>
  ({
    paths: {
      type: 'array',
      items: {
        type: 'string',
      },
      description: `Copy each path exactly as given. Max ${MAX_BATCH_READ_FILES} items.`,
    },
    sourcePath: {
      type: 'string',
      description:
        "Optional vault path of the note the wikilink targets are being resolved from, to match Obsidian's link-resolution rules (relative/shortest-path). Only affects wikilink-style paths entries; ignored otherwise. Omit to resolve against the vault-wide best match.",
    },
    startLine: {
      type: 'integer',
      description:
        'Start line/page (1-based). Providing this selects a targeted read; omit all range fields for a full read.',
    },
    endLine: {
      type: 'integer',
      description:
        'Inclusive end line/page. Requires startLine and cannot be combined with maxLines.',
    },
    maxLines: {
      type: 'integer',
      description:
        'Maximum lines/pages to return. Requires startLine and cannot be combined with endLine. When both endLine and maxLines are omitted, text-like content defaults to 50 lines and PDFs default to one page.',
    },
    format: {
      type: 'string',
      enum: ['readable', 'key_visible_info'],
      description:
        'Browser pages only. key_visible_info (default): compact visible headings, text blocks, tables, code, and formulas — prefer for long pages. readable: fuller Markdown-like text.',
    },
  }) as const

const FS_READ_DESCRIPTION = [
  'Read vault files, listed skills, or open web pages.',
  '',
  'paths: copy exactly from the source. Do not invent prefixes.',
  '- vault file: vault-relative path',
  '- skill: the path field in <available_skills>',
  '- open page: browser://<page_id> from <browser_context>',
  '- wikilink: [[Note#Heading]] or bare Note#^blockId (nested headings ok; .md optional). Exact vault path wins first.',
  '',
  'Omit range fields for a full read. Targeted read: startLine and optionally endLine or maxLines (1-based; PDF pages). Office files (.docx/.pptx/.xlsx) parse to markdown.',
  '',
  'browser://:',
  '- copy page_id from <browser_context>; never invent browser://https://... or browser://domain/path',
  '- do not call when <browser_context> is absent',
  '- does not fetch internet content; use web_search or web_scrape when available',
].join('\n')

export const fsReadDefinition = defineTool({
  name: 'fs_read',
  // Must be a function: the `modality` schema field is tailored per active
  // chat model (see `buildFsReadModalitySchema`'s doc comment) — omitted
  // entirely for text-only models, `['text', 'pdf']` for PDF-capable models,
  // `['text', 'image']` for vision-capable (non-PDF) models. This is the
  // reason `BuiltinToolDefinition.getMcpTool` is typed as `(ctx) => ...`
  // rather than a constant (master.md §3.3).
  getMcpTool: (ctx) => {
    const modalitySchema = buildFsReadModalitySchema(ctx.chatModelModalities)
    return {
      description: FS_READ_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          ...buildFsReadBaseSchemaProperties(),
          ...(modalitySchema ? { modality: modalitySchema } : {}),
        },
        required: ['paths'],
      },
    } satisfies Omit<McpTool, 'name'>
  },
  chatLabel: {
    key: 'settings.agent.builtinFsReadLabel',
    fallback: 'Read File',
  },
  contextPrunable: true,
  // Ported verbatim from the `case 'fs_read'` branch of `callLocalFileTool`
  // (`src/core/mcp/localFileTools.ts`, pre-migration), minus the abort check
  // / workspace-scope / YOLO-data-root guards on the *top-level path
  // parameter* and the outer try/catch — those are dispatcher
  // responsibilities (master.md §3.4). The rest of this function's own
  // per-resolved-path checks (YOLO-data-root re-check after wikilink
  // resolution, workspace-scope re-check after wikilink resolution) are
  // deliberately NOT dispatcher responsibilities and stay here — see
  // master.md §5's "解析级检查" carve-out: wikilink targets are not literal
  // path strings until resolved inside this function, so
  // `enforceBuiltinToolSecurityBoundary`'s raw-argument scan structurally
  // cannot see them. Duplicating those two checks here is not "the tool
  // redoing the dispatcher's job" — it is the only place they can run.
  execute: async (args, ctx) => {
    const {
      app,
      settings,
      signal,
      chatModelId,
      workspaceScope,
      allowedSkillPaths,
    } = ctx

    const paths = getStringArrayArg(args, 'paths')
      .map((path) => normalizeFsReadPath(path))
      .filter((path, index, arr) => arr.indexOf(path) === index)

    if (paths.length === 0) {
      throw new Error('paths cannot be empty.')
    }
    if (paths.length > MAX_BATCH_READ_FILES) {
      throw new Error(
        `paths supports up to ${MAX_BATCH_READ_FILES} files per call.`,
      )
    }
    const operation = getFsReadOperation(args)
    // Resolution context for wikilink-style path entries (see the fallback
    // resolution below). Not a path read from — just the linking note's
    // path, mirroring how Obsidian resolves real wikilinks. Not subject to
    // workspace-scope checks itself.
    const rawSourcePath = getOptionalTextArg(args, 'sourcePath')?.trim()
    const sourcePath =
      rawSourcePath && rawSourcePath.length > 0
        ? validateVaultPath(rawSourcePath)
        : undefined
    const allowedSkillPathSet = allowedSkillPaths
      ? buildAllowedSkillPathSet(allowedSkillPaths)
      : undefined

    const results: Array<
      | {
          path: string
          ok: true
          totalLines: number
          returnedRange?: {
            startLine: number | null
            endLine: number | null
          }
          hasMoreBelow: boolean
          nextStartLine: number | null
          content: string
          wikilinks?: Array<{ link: string; path: string }>
          effectiveModality?: 'text' | 'image' | 'pdf'
          warning?: string
          url?: string
          title?: string
          loading?: boolean
          redactions?: Array<{ kind: string; count: number }>
          partial?: { reason: string; message: string }
          // Present when this entry was resolved via wikilink fallback
          // rather than an exact vault path match (see the resolution loop
          // below).
          resolvedPath?: string
          resolvedSubpath?: WikilinkReadSubpath
        }
      | {
          path: string
          ok: false
          error: string
        }
    > = []
    const readSkillNames: string[] = []

    // Tool result attachments hoisted to a follow-up user message after the
    // tool block. Mostly image_url for rendered PDFs/images, but also
    // `document` for native PDF slices.
    const perFileAttachmentParts: Array<{
      path: string
      parts: ContentPart[]
    }> = []

    // Skip image extraction when the active chat model does not accept
    // vision input; otherwise we'd ship base64 payloads to a text-only
    // endpoint and get a 400 back (issue #255). Migration 48→49 backfills
    // `modalities` on every ChatModel, so a missing array here means we
    // either have no active model or the lookup failed — treat as allow.
    const activeChatModel =
      chatModelId && settings?.chatModels
        ? (settings.chatModels.find((m) => m.id === chatModelId) ?? null)
        : null
    const chatModelAcceptsImages = activeChatModel
      ? chatModelSupportsVision(activeChatModel)
      : true
    // Conservative: when no active model is known, don't assume PDF support.
    const chatModelAcceptsPdf = activeChatModel
      ? chatModelSupportsPdf(activeChatModel)
      : false

    for (const path of paths) {
      if (signal?.aborted) {
        return { status: ToolCallResponseStatus.Aborted }
      }

      if (allowedSkillPathSet?.has(normalizeSkillPathForExemption(path))) {
        const skillDocument = await getLiteSkillDocumentByPath({
          app,
          path,
          settings,
        })
        if (!skillDocument) {
          results.push({ path, ok: false, error: 'Skill not found.' })
          continue
        }

        const content = skillDocument.content
        const lines = content.length === 0 ? [] : content.split('\n')
        const sliced = sliceLinesForFsReadOperation(lines, operation)

        results.push({
          path,
          ok: true,
          totalLines: sliced.totalLines,
          returnedRange:
            operation.type === 'lines'
              ? {
                  startLine: sliced.returnedStartLine,
                  endLine: sliced.returnedEndLine,
                }
              : undefined,
          hasMoreBelow: sliced.hasMoreBelow,
          nextStartLine: sliced.nextStartLine,
          content: sliced.outputContent,
        })
        readSkillNames.push(skillDocument.entry.name)
        continue
      }

      if (isBrowserReadPath(path)) {
        if (Platform.isMobile) {
          results.push({
            path,
            ok: false,
            error: 'Reading open web pages via fs_read is desktop-only.',
          })
          continue
        }

        const pageId = parseBrowserReadPageId(path)
        const handle = findWebviewHandleByPageId(app, pageId)
        if (!handle) {
          results.push({
            path,
            ok: false,
            error: `No open web page with page_id "${pageId}" was found. The tab may have been closed or replaced.`,
          })
          continue
        }

        const format = operation.format ?? 'key_visible_info'
        try {
          const browserResult = await readActiveWebviewPage(handle, {
            format,
            signal,
          })
          if (!browserResult) {
            results.push({
              path,
              ok: false,
              error:
                'Webview is present but has no loaded page (URL empty or about:blank). Navigate to a URL first.',
            })
            continue
          }

          const text = browserResult.text ?? ''
          const lines = text.length === 0 ? [] : text.split('\n')
          const sliced = sliceLinesForFsReadOperation(lines, operation)
          results.push({
            path,
            ok: true,
            totalLines: sliced.totalLines,
            returnedRange:
              operation.type === 'lines'
                ? {
                    startLine: sliced.returnedStartLine,
                    endLine: sliced.returnedEndLine,
                  }
                : undefined,
            hasMoreBelow: sliced.hasMoreBelow,
            nextStartLine: sliced.nextStartLine,
            content: sliced.outputContent,
            url: browserResult.url,
            title: browserResult.title,
            loading: browserResult.loading,
            redactions: browserResult.redactions,
            ...(browserResult.partial
              ? { partial: browserResult.partial }
              : {}),
          })
        } catch (error) {
          if (error instanceof BrowserReadFailure) {
            results.push({
              path,
              ok: false,
              error: `${error.code}: ${error.message}`,
            })
            continue
          }
          throw error
        }
        continue
      }

      // Exact vault path first (unchanged from prior behavior). Only on a
      // miss do we try wikilink resolution — an explicit `[[...]]` wrapper
      // can never be a valid exact path, and Obsidian filenames can't
      // contain '#', so subpathed links can't collide with exact paths
      // either.
      let file = app.vault.getFileByPath(path)
      let resolvedPath: string | undefined
      let resolvedSubpath: WikilinkReadSubpath | undefined
      let subpathWarning: string | undefined

      if (!file) {
        const target = resolveWikilinkReadTarget(app, path, sourcePath)
        if (!target) {
          results.push({
            path,
            ok: false,
            error: `File not found. "${path}" did not match a vault path or a resolvable wikilink target.`,
          })
          continue
        }
        file = target.file
        resolvedPath = file.path
        if (target.subpath) {
          resolvedSubpath = target.subpath
        } else if (target.subpathError) {
          subpathWarning = target.subpathError
        }
      }

      // Both the YOLO user-data root and workspace-scope checks live here
      // rather than relying solely on the dispatcher's top-level raw-string
      // scan (`enforceBuiltinToolSecurityBoundary`): a wikilink target's
      // resolved `file.path` may never have appeared as a literal string in
      // `args` (master.md §5's "解析级检查"), so this is the only place that
      // scan can happen. Applies uniformly to exact-match and
      // wikilink-resolved entries; files inside an allowed skill package
      // keep the same exemption they had under `findPathOutsideScope`'s
      // `exemptPaths` option.
      //
      // The judgment itself (`resolvePathVisibility`) is evaluated against
      // `file.path` — the real, resolved location — because that's what
      // actually needs guarding. But the *message* passed to
      // `describePathDenial` is the original `path` the agent supplied
      // (which may be an unresolved wikilink like "[[Secret]]"), never
      // `file.path`. Echoing the resolved path here was issue #577: it let
      // an agent that had no way to know a wikilink resolved outside its
      // workspace scope learn the real path anyway, purely from the denial
      // message.
      const visibility = resolvePathVisibility(file.path, {
        scope: workspaceScope,
        settings,
        exemptPaths: allowedSkillPathSet,
      })
      if (visibility !== 'visible') {
        results.push({
          path,
          ok: false,
          error: describePathDenial(visibility, path),
        })
        continue
      }

      const wikilinkResultFields: {
        resolvedPath?: string
        resolvedSubpath?: WikilinkReadSubpath
      } = resolvedPath
        ? {
            resolvedPath,
            ...(resolvedSubpath ? { resolvedSubpath } : {}),
          }
        : {}

      const isPdf = file.extension?.toLowerCase() === 'pdf'
      if (isPdf) {
        if (file.stat.size > PDF_INDEX_MAX_BYTES) {
          results.push({
            path,
            ok: false,
            error: `PDF too large (${file.stat.size} bytes).`,
          })
          continue
        }

        // Resolve the effective modality for this PDF read. The schema
        // exposed to the model is tailored per capability (see
        // buildFsReadModalitySchema), so normally the requested modality is
        // already aligned with what the model can use. The branches below
        // also handle the "out-of-schema" cases (model somehow sends image
        // to a PDF-capable model, or pdf to a vision-only model) — those
        // resolve to the strictly-better alternative rather than failing.
        //
        // Decision table:
        //   ── PDF-capable model ──
        //     undefined → pdf
        //     'pdf'     → pdf
        //     'text'    → text  (cheap path; respected verbatim)
        //     'image'   → pdf   (image is redundant when native PDF is
        //                       available — native PDF is strictly more
        //                       informative; this branch is a safety net,
        //                       schema doesn't expose image to these
        //                       models)
        //   ── vision-capable (non-PDF) ──
        //     undefined → text
        //     'pdf'     → text  (pdf not supported; safety-net downgrade)
        //     'text'    → text
        //     'image'   → image if image-read setting enabled, else text
        //   ── text-only ──
        //     all paths → text (no other modality is supported)
        const imageReadingEnabled =
          settings?.chatOptions?.imageReadingEnabled ?? true
        const canUseImage = chatModelAcceptsImages && imageReadingEnabled
        const resolvedModality: 'pdf' | 'image' | 'text' = (() => {
          if (chatModelAcceptsPdf) {
            switch (operation.modality) {
              case undefined:
              case 'pdf':
              case 'image':
                return 'pdf'
              case 'text':
                return 'text'
            }
          }
          switch (operation.modality) {
            case undefined:
            case 'pdf':
            case 'text':
              return 'text'
            case 'image':
              return canUseImage ? 'image' : 'text'
          }
        })()

        // ── Native PDF slice branch ────────────────────────────────────
        if (resolvedModality === 'pdf') {
          const reqStart = operation.type === 'lines' ? operation.startLine : 1
          // 范围读取显式给 maxLines 时按页数计算；未给 endLine/maxLines
          // 时保留低成本探查语义，只读 startLine 对应的单页。
          // full 模式的 endPage 留空，由 slicePdfPages 自动取到文档末页。
          const reqEnd =
            operation.type === 'lines'
              ? (operation.endLine ??
                (operation.maxLines !== undefined
                  ? operation.startLine + operation.maxLines - 1
                  : operation.startLine))
              : undefined

          // Attempt to slice the PDF. slicePdfPages loads the source once
          // and reports total page count + clamped range; on failure it
          // throws a tagged PdfSliceError. Caller-side reaction depends on
          // the kind:
          //   • 'invalid-range' (e.g. startPage > totalPages) is a hard
          //     model-facing error — degrading to text would silently hide
          //     a bad page request.
          //   • all other kinds (load-failed / too-large / too-many-pages)
          //     fall through to text extraction with a warning prefix.
          let sliceResult: Awaited<ReturnType<typeof slicePdfPages>> | undefined
          let sliceFallbackWarning: string | undefined

          try {
            const rawBuf = await app.vault.readBinary(file)
            const rawBytes = new Uint8Array(rawBuf)
            sliceResult = await slicePdfPages(rawBytes, {
              startPage: reqStart,
              endPage: reqEnd,
            })
          } catch (err) {
            if (err instanceof PdfSliceError && err.kind === 'invalid-range') {
              results.push({
                path,
                ok: false,
                error: err.message,
              })
              continue
            }
            sliceFallbackWarning =
              err instanceof Error ? err.message : String(err)
          }

          if (sliceResult !== undefined) {
            // Slice succeeded — emit the document part.
            const {
              bytes: slicedBytes,
              totalSourcePages,
              actualStart,
              actualEnd,
            } = sliceResult
            const slicePageCount = actualEnd - actualStart + 1

            const base64Data = uint8ArrayToBase64(slicedBytes)
            const documentPart: ContentPart = {
              type: 'document',
              mediaType: 'application/pdf',
              name: `${file.name} (pages ${actualStart}–${actualEnd})`,
              data: base64Data,
              pageCount: slicePageCount,
            }

            const hasMoreBelow =
              operation.type === 'lines' && actualEnd < totalSourcePages
            const nextStartLine = hasMoreBelow ? actualEnd + 1 : null

            results.push({
              path,
              ok: true,
              totalLines: totalSourcePages,
              returnedRange:
                operation.type === 'lines'
                  ? { startLine: actualStart, endLine: actualEnd }
                  : undefined,
              hasMoreBelow,
              nextStartLine,
              // Explain page-number renumbering so the model cites original
              // page numbers (actualStart–actualEnd) rather than the
              // slice-internal numbers (1–slicePageCount).
              content: `Read pages ${actualStart}–${actualEnd} of "${file.name}" (original document has ${totalSourcePages} pages).\nThe attached PDF slice contains those pages renumbered as 1–${slicePageCount} internally, but you should refer to them by their ORIGINAL page numbers (${actualStart}–${actualEnd}) when citing.`,
              effectiveModality: 'pdf' as const,
              ...wikilinkResultFields,
              ...(subpathWarning ? { warning: subpathWarning } : {}),
            })
            perFileAttachmentParts.push({ path, parts: [documentPart] })
            continue
          }

          // Slice failed — fall through to text extraction with a warning prefix.
          let pdfSliceFallbackPages: { page: number; text: string }[] = []
          try {
            const extracted = await extractPdfText(app, file, {
              signal,
              maxBinaryBytes: PDF_INDEX_MAX_BYTES,
              maxPages: PDF_INDEX_MAX_PAGES,
              settings,
            })
            pdfSliceFallbackPages = extracted.pages
          } catch (extractErr) {
            if (
              extractErr instanceof DOMException &&
              extractErr.name === 'AbortError'
            ) {
              return { status: ToolCallResponseStatus.Aborted }
            }
            results.push({
              path,
              ok: false,
              error:
                extractErr instanceof Error
                  ? extractErr.message
                  : 'Failed to extract PDF text.',
            })
            continue
          }

          const fbTotalPageCount = pdfSliceFallbackPages.length
          const fbRangeStart = operation.type === 'lines' ? reqStart : 1
          const fbRangeEnd =
            operation.type === 'full'
              ? fbTotalPageCount
              : Math.min(reqEnd ?? fbRangeStart, fbTotalPageCount)
          const fbSelectedPages = pdfSliceFallbackPages.filter(
            (p) => p.page >= fbRangeStart && p.page <= fbRangeEnd,
          )
          const fbTaggedBody = fbSelectedPages
            .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
            .join('\n')
          const fbWarningPrefix = `[PDF native slice failed for pages ${fbRangeStart}–${fbRangeEnd}, falling back to text extraction. Reason: ${sliceFallbackWarning ?? 'unknown error'}]\n\n`

          results.push({
            path,
            ok: true,
            totalLines: fbTotalPageCount,
            returnedRange:
              operation.type === 'lines'
                ? {
                    startLine: fbSelectedPages.length > 0 ? fbRangeStart : null,
                    endLine: fbSelectedPages.length > 0 ? fbRangeEnd : null,
                  }
                : undefined,
            hasMoreBelow:
              operation.type === 'lines' && fbRangeEnd < fbTotalPageCount,
            nextStartLine:
              operation.type === 'lines' && fbRangeEnd < fbTotalPageCount
                ? fbRangeEnd + 1
                : null,
            content: fbWarningPrefix + fbTaggedBody,
            effectiveModality: 'text' as const,
            warning: subpathWarning
              ? `${fbWarningPrefix.trim()} ${subpathWarning}`
              : fbWarningPrefix.trim(),
            ...wikilinkResultFields,
          })
          continue
        }

        // ── Image render branch ────────────────────────────────────────
        // resolvedModality has already taken vision capability and the
        // image-reading setting into account; checking it here is enough.
        if (resolvedModality === 'image') {
          // Mirror text-mode semantics where it makes sense:
          //   - `full`  → render every page (matches "full = whole file").
          //   - targeted read with maxLines → render that many pages.
          //   - targeted read without endLine/maxLines → render only
          //     startLine. This gives the model a cheap peek that returns
          //     totalPages before it asks for a precise range.
          const reqStart = operation.type === 'lines' ? operation.startLine : 1
          const reqEnd =
            operation.type === 'lines'
              ? (operation.endLine ??
                (operation.maxLines !== undefined
                  ? operation.startLine + operation.maxLines - 1
                  : operation.startLine))
              : undefined

          let renderResult: Awaited<ReturnType<typeof renderPdfPagesToImages>>
          try {
            renderResult = await renderPdfPagesToImages(
              app,
              file,
              reqStart,
              reqEnd,
              settings,
            )
          } catch (error) {
            results.push({
              path,
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to render PDF pages as images.',
            })
            continue
          }

          const { totalPages, rendered } = renderResult
          const rangeStartPage = reqStart
          const rangeEndPageInclusive =
            reqEnd === undefined ? totalPages : Math.min(reqEnd, totalPages)
          const returnedCount = rendered.length
          const returnedStartLine = returnedCount > 0 ? rangeStartPage : null
          const returnedEndLine =
            returnedCount > 0 ? rangeEndPageInclusive : null
          const hasMoreBelow = rangeEndPageInclusive < totalPages
          const nextStartLine = hasMoreBelow ? rangeEndPageInclusive + 1 : null

          results.push({
            path,
            ok: true,
            totalLines: totalPages,
            returnedRange: {
              startLine: returnedStartLine,
              endLine: returnedEndLine,
            },
            hasMoreBelow,
            nextStartLine,
            content: '',
            ...wikilinkResultFields,
            ...(subpathWarning ? { warning: subpathWarning } : {}),
          })

          if (rendered.length > 0) {
            perFileAttachmentParts.push({
              path,
              parts: rendered.map((r) => ({
                type: 'image_url' as const,
                image_url: {
                  url: r.dataUrl,
                  cacheKey: buildPdfPageImageCacheKey(
                    file.path,
                    file.stat.mtime,
                    file.stat.size,
                    r.page,
                  ),
                },
              })),
            })
          }
          continue
        }

        let pages: { page: number; text: string }[] = []
        try {
          const extracted = await extractPdfText(app, file, {
            signal,
            maxBinaryBytes: PDF_INDEX_MAX_BYTES,
            maxPages: PDF_INDEX_MAX_PAGES,
            settings,
          })
          pages = extracted.pages
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            return { status: ToolCallResponseStatus.Aborted }
          }
          results.push({
            path,
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : 'Failed to extract PDF text.',
          })
          continue
        }

        const totalPageCount = pages.length
        let rangeStartPage = 1
        let rangeEndPageInclusive = totalPageCount
        if (operation.type === 'lines') {
          rangeStartPage = operation.startLine
          // PDF defaults to a single page when neither endLine nor maxLines
          // is provided — a PDF page carries far more content than a
          // markdown line. Explicit maxLines counts pages.
          rangeEndPageInclusive = Math.min(
            operation.endLine ??
              (operation.maxLines !== undefined
                ? rangeStartPage + operation.maxLines - 1
                : rangeStartPage),
            totalPageCount,
          )
          if (rangeEndPageInclusive < rangeStartPage) {
            results.push({
              path,
              ok: false,
              error: 'endLine must be greater than or equal to startLine.',
            })
            continue
          }
          if (rangeEndPageInclusive - rangeStartPage + 1 > MAX_READ_MAX_LINES) {
            results.push({
              path,
              ok: false,
              error: `Requested page range is too large. Maximum ${MAX_READ_MAX_LINES} pages per file.`,
            })
            continue
          }
        }

        const selectedPages = pages.filter(
          (p) => p.page >= rangeStartPage && p.page <= rangeEndPageInclusive,
        )

        const taggedBody = selectedPages
          .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
          .join('\n')
        if (taggedBody.length > MAX_FILE_SIZE_BYTES) {
          results.push({
            path,
            ok: false,
            error: `Extracted PDF text too large (${taggedBody.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
          })
          continue
        }

        // PDF 场景下 line 语义 = 页号。不做 `${index+1}|` 前缀，避免
        // 与 returnedRange（页号）语义错位，LLM 可直接依赖 <page N> 标签定位。
        const totalLines = totalPageCount
        const outputContent = taggedBody
        const returnedCount = selectedPages.length
        const returnedStartLine = returnedCount > 0 ? rangeStartPage : null
        const returnedEndLine = returnedCount > 0 ? rangeEndPageInclusive : null
        const hasMoreBelow =
          operation.type === 'lines' && rangeEndPageInclusive < totalPageCount
        const nextStartLine = hasMoreBelow ? rangeEndPageInclusive + 1 : null

        // When an explicit modality request was silently re-mapped to text
        // by the resolver, mark `effectiveModality` so callers / log readers
        // can observe the divergence between requested and executed mode.
        // Default (undefined) lands here too — but we only emit the marker
        // when there's an actual divergence.
        //
        // Two visible divergences trigger metadata:
        //   - 'image' on text-only model → text (caller asked for image but
        //     the model can't do vision). Carries a model-visible warning so
        //     the model knows its visual request was lost.
        //   - 'pdf' on non-PDF model → text (caller asked for native PDF,
        //     model doesn't support it). No warning text — the downgrade is
        //     the system's choice, not something the model should try to
        //     "correct" by asking again.
        const visionDowngraded =
          operation.modality === 'image' && !chatModelAcceptsImages
        const pdfDowngraded =
          operation.modality === 'pdf' && !chatModelAcceptsPdf

        results.push({
          path,
          ok: true,
          totalLines,
          returnedRange:
            operation.type === 'lines'
              ? {
                  startLine: returnedStartLine,
                  endLine: returnedEndLine,
                }
              : undefined,
          hasMoreBelow,
          nextStartLine,
          content: outputContent,
          ...(visionDowngraded
            ? {
                effectiveModality: 'text' as const,
                warning: subpathWarning
                  ? `当前模型不支持图像输入，已自动降级为文本读取 ${subpathWarning}`
                  : '当前模型不支持图像输入，已自动降级为文本读取',
              }
            : pdfDowngraded
              ? {
                  effectiveModality: 'text' as const,
                  ...(subpathWarning ? { warning: subpathWarning } : {}),
                }
              : subpathWarning
                ? { warning: subpathWarning }
                : {}),
          ...wikilinkResultFields,
        })
        continue
      }

      const officeKind = getOfficeDocumentKindFromExtension(file.extension)
      if (officeKind) {
        if (file.stat.size > OFFICE_READ_MAX_BYTES) {
          results.push({
            path,
            ok: false,
            error: `Office document too large (${file.stat.size} bytes).`,
          })
          continue
        }

        try {
          const rawBuf = await app.vault.readBinary(file)
          const parsed = await parseOfficeDocument(rawBuf, officeKind)
          const content = parsed.markdown
          const lines = content.length === 0 ? [] : content.split('\n')
          const sliced = sliceLinesForFsReadOperation(lines, operation)

          results.push({
            path,
            ok: true,
            totalLines: sliced.totalLines,
            returnedRange:
              operation.type === 'lines'
                ? {
                    startLine: sliced.returnedStartLine,
                    endLine: sliced.returnedEndLine,
                  }
                : undefined,
            hasMoreBelow: sliced.hasMoreBelow,
            nextStartLine: sliced.nextStartLine,
            content: sliced.outputContent,
            ...wikilinkResultFields,
            ...(subpathWarning ? { warning: subpathWarning } : {}),
          })
        } catch (error) {
          results.push({
            path,
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : typeof error === 'string'
                  ? error
                  : JSON.stringify(error),
          })
        }
        continue
      }

      if (file.stat.size > MAX_FILE_SIZE_BYTES) {
        results.push({
          path,
          ok: false,
          error: `File too large (${file.stat.size} bytes).`,
        })
        continue
      }

      // A subpath resolved from wikilink fallback only takes effect for a
      // `full` read — an explicit startLine/endLine/maxLines from the
      // caller always wins and the subpath is used only to locate the file.
      const effectiveOperation: FsReadOperation =
        resolvedSubpath && operation.type === 'full'
          ? {
              type: 'lines',
              startLine: resolvedSubpath.startLine,
              endLine: resolvedSubpath.endLine,
              modality: operation.modality,
              format: operation.format,
            }
          : operation

      const rawContent = await app.vault.read(file)
      const content = rawContent
      const lines = content.length === 0 ? [] : content.split('\n')
      const sliced = sliceLinesForFsReadOperation(lines, effectiveOperation)
      const outputContent = sliced.outputContent
      const rawSelected = sliced.rawSelected

      const wikilinks =
        file.extension === 'md' && rawSelected.length > 0
          ? collectWikilinkPaths(app, rawSelected, file.path)
          : []

      results.push({
        path,
        ok: true,
        totalLines: sliced.totalLines,
        returnedRange:
          effectiveOperation.type === 'lines'
            ? {
                startLine: sliced.returnedStartLine,
                endLine: sliced.returnedEndLine,
              }
            : undefined,
        hasMoreBelow: sliced.hasMoreBelow,
        nextStartLine: sliced.nextStartLine,
        content: outputContent,
        ...(wikilinks.length > 0 ? { wikilinks } : {}),
        ...wikilinkResultFields,
        ...(subpathWarning ? { warning: subpathWarning } : {}),
      })

      // Extract images from markdown files using the outputContent (which
      // is the line-numbered text that was actually returned)
      if (
        chatModelAcceptsImages &&
        (settings?.chatOptions?.imageReadingEnabled ?? true) &&
        file.extension === 'md' &&
        outputContent.length > 0
      ) {
        const imageResult = await extractMarkdownImages(
          app,
          outputContent,
          file.path,
          {
            compression: {
              enabled: settings?.chatOptions?.imageCompressionEnabled ?? true,
              quality: settings?.chatOptions?.imageCompressionQuality ?? 85,
            },
            cache: { enabled: true, settings },
            externalUrl: {
              enabled:
                settings?.chatOptions?.externalImageFetchEnabled ?? false,
            },
          },
        )
        if (imageResult.contentParts) {
          perFileAttachmentParts.push({
            path,
            parts: imageResult.contentParts,
          })
        }
      }
    }

    const textResult = formatJsonResult({
      toolCallId: ctx.toolCallId ?? null,
      // Echo the requested modality so the model can compare it against each
      // result's `effectiveModality` (only set when we forcibly downgrade
      // image→text because the model lacks vision capability).
      requestedOperation: {
        type: operation.type,
        modality: operation.modality,
      },
      results,
    })

    // contentParts only carries image payloads — the request builder filters
    // to image_url parts and ignores any text entries here, so we skip
    // building per-file text headers that would just be discarded. The text
    // JSON (above) is the source of truth for paths/ranges.
    const contentParts: ContentPart[] | undefined =
      perFileAttachmentParts.length > 0
        ? perFileAttachmentParts.flatMap((p) => p.parts)
        : undefined

    const firstReadableResult = results[0]?.ok ? results[0] : undefined
    const isPdf =
      typeof firstReadableResult?.path === 'string' &&
      firstReadableResult.path.toLowerCase().endsWith('.pdf')
    const fsReadOperation: ToolFsReadOperationSummary | undefined = (() => {
      if (!firstReadableResult) {
        return undefined
      }
      if (operation.type === 'full') {
        return {
          type: 'full',
          isPdf,
          ...(readSkillNames.length === paths.length
            ? { skillNames: readSkillNames }
            : {}),
        }
      }
      const returnedRange = firstReadableResult.returnedRange
      if (
        typeof returnedRange?.startLine !== 'number' ||
        typeof returnedRange.endLine !== 'number'
      ) {
        return undefined
      }
      return {
        type: 'lines',
        startLine: returnedRange.startLine,
        endLine: returnedRange.endLine,
        isPdf,
        ...(readSkillNames.length === paths.length
          ? { skillNames: readSkillNames }
          : {}),
      }
    })()

    return {
      status: ToolCallResponseStatus.Success,
      text: textResult,
      contentParts,
      metadata: fsReadOperation ? { fsReadOperation } : undefined,
    }
  },
})
