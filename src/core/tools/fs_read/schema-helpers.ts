import type { ChatModelModality } from '../../../types/chat-model.types'
import type { OfficeDocumentKind } from '../../../utils/office'
import {
  BROWSER_READ_PATH_PREFIX,
  BUILTIN_SKILL_PATH_PREFIX,
} from '../../agent/workspaceScope'
import { BROWSER_PAGE_ID_PATTERN } from '../../browser/activeWebviewProbe'
import type { BrowserReadFormat } from '../../browser/activeWebviewReader'
import { validateVaultPath } from '../../mcp/vaultFileOps'
import { getOptionalBoundedIntegerArg } from '../tool-args'

// fs_read-exclusive schema/parsing helpers, types, and limits. Everything in
// this file has exactly one consumer — `fs_read` — so it lives in that
// tool's own directory (phase2-migration.md D6 "注意").

export const MAX_BATCH_READ_FILES = 20
export const OFFICE_READ_MAX_BYTES = 10 * 1024 * 1024
export const MAX_READ_MAX_LINES = 2000
const DEFAULT_READ_START_LINE = 1
const DEFAULT_READ_MAX_LINES = 50
const MAX_READ_LINE_INDEX = 1_000_000

// Also consumed by `localFileTools.ts`'s `normalizeBrowserReadPageId` (the
// js_eval sandbox's browser-read path parser, an unrelated not-yet-migrated
// tool) — that function imports this constant back from here.
export const BROWSER_READ_PATH_USAGE =
  'browser:// paths only read open Obsidian web pages by page_id copied exactly from <browser_context> (browser://page_<8 lowercase base36>_<8 lowercase base36>). Do not append URL paths to a page_id and do not use browser:// to open or fetch internet URLs. For internet access, use web_search or web_scrape when available; if those tools are unavailable, tell the user.'

export function getOfficeDocumentKindFromExtension(
  extension: string | undefined,
): OfficeDocumentKind | null {
  const normalized = extension?.toLowerCase()
  if (normalized === 'docx' || normalized === 'pptx' || normalized === 'xlsx') {
    return normalized
  }
  return null
}

export const normalizeFsReadPath = (path: string): string => {
  const trimmed = path.trim()
  if (trimmed.length === 0) {
    throw new Error('Path is required.')
  }
  if (trimmed.startsWith(BUILTIN_SKILL_PATH_PREFIX)) {
    return trimmed
  }
  if (trimmed.startsWith(BROWSER_READ_PATH_PREFIX)) {
    parseBrowserReadPageId(trimmed)
    return trimmed
  }
  return validateVaultPath(trimmed)
}

export const isBrowserReadPath = (path: string): boolean =>
  path.trim().startsWith(BROWSER_READ_PATH_PREFIX)

export const parseBrowserReadPageId = (path: string): string => {
  const trimmed = path.trim()
  if (!trimmed.startsWith(BROWSER_READ_PATH_PREFIX)) {
    throw new Error('Not a browser read path.')
  }
  const pageId = trimmed.slice(BROWSER_READ_PATH_PREFIX.length).trim()
  if (!BROWSER_PAGE_ID_PATTERN.test(pageId)) {
    throw new Error(BROWSER_READ_PATH_USAGE)
  }
  return pageId
}

// PDF read modality override. Omitted = default behavior (native PDF when the
// chat model supports it, otherwise text). Concrete values are presented to
// the model via a per-capability schema (see buildFsReadModalitySchema):
//   - PDF-capable models: ['text', 'pdf']
//   - vision-capable (non-PDF): ['text', 'image']
//   - text-only: field is omitted from the schema entirely
// The parser still accepts the full superset for resilience (see notes there).
export type FsReadModality = 'text' | 'image' | 'pdf'
export type FsReadOperation =
  | {
      type: 'full'
      modality?: FsReadModality
      format?: BrowserReadFormat
    }
  | {
      type: 'lines'
      startLine: number
      endLine?: number
      maxLines?: number
      modality?: FsReadModality
      format?: BrowserReadFormat
    }

type FsReadLineSliceResult = {
  outputContent: string
  rawSelected: string
  totalLines: number
  returnedStartLine: number | null
  returnedEndLine: number | null
  hasMoreBelow: boolean
  nextStartLine: number | null
}

export const sliceLinesForFsReadOperation = (
  lines: string[],
  operation: FsReadOperation,
): FsReadLineSliceResult => {
  const totalLines = lines.length
  if (operation.type === 'full') {
    const outputContent = lines
      .map((line, index) => `${index + 1}|${line}`)
      .join('\n')
    return {
      outputContent,
      rawSelected: lines.join('\n'),
      totalLines,
      returnedStartLine: totalLines > 0 ? 1 : null,
      returnedEndLine: totalLines > 0 ? totalLines : null,
      hasMoreBelow: false,
      nextStartLine: null,
    }
  }

  const startIndex = Math.min(Math.max(operation.startLine - 1, 0), totalLines)
  const endExclusive = Math.min(
    totalLines,
    operation.endLine ??
      startIndex + (operation.maxLines ?? DEFAULT_READ_MAX_LINES),
  )
  const selectedLines = lines.slice(startIndex, endExclusive)
  const outputContent = selectedLines
    .map((line, index) => `${startIndex + index + 1}|${line}`)
    .join('\n')
  const returnedCount = selectedLines.length
  const hasMoreBelow = endExclusive < totalLines
  return {
    outputContent,
    rawSelected: selectedLines.join('\n'),
    totalLines,
    returnedStartLine: returnedCount > 0 ? startIndex + 1 : null,
    returnedEndLine: returnedCount > 0 ? startIndex + returnedCount : null,
    hasMoreBelow,
    nextStartLine: hasMoreBelow ? endExclusive + 1 : null,
  }
}

/**
 * Build the modality enum + description fragment exposed to the current chat
 * model in fs_read's schema.
 *
 *   - PDF-capable model      → ['text', 'pdf']
 *   - vision (non-PDF) model → ['text', 'image']
 *   - text-only model        → undefined (field is omitted from schema)
 *   - no model context       → ['text', 'image', 'pdf'] (superset; used by UI
 *                              listings and permission persistence — the LLM
 *                              never sees this branch because every runtime
 *                              call site threads the active model through)
 *
 * Image and pdf are mutually exclusive by product definition: image is only a
 * workaround for models lacking native PDF input, and pdf is meaningless on
 * models that can't accept it. Tailoring the enum per model collapses the
 * "model picks a value that has to be silently corrected" failure mode into
 * "the wrong value isn't representable to begin with."
 */
export const buildFsReadModalitySchema = (
  modalities: ChatModelModality[] | undefined,
): { type: 'string'; enum: string[]; description: string } | undefined => {
  const isPdfCapable = modalities?.includes('pdf')
  const isVisionCapable = modalities?.includes('vision')

  if (!modalities) {
    // Superset (UI / permission listing). Not seen by any live LLM call.
    return {
      type: 'string',
      enum: ['text', 'image', 'pdf'],
      description:
        'PDF-only modality override. Omit for the default per active model. text = plain text extraction. image = render pages as images (only available on vision-capable, non-PDF-capable models). pdf = native PDF input (only available on PDF-capable models). Ignored for non-PDF files.',
    }
  }

  if (isPdfCapable) {
    return {
      type: 'string',
      enum: ['text', 'pdf'],
      description:
        'PDF-only modality override. Omit for default (= "pdf"). "text" = plain text extraction (cheap and fast; pick this only when the user explicitly asks for text-only). "pdf" = native PDF input (highest fidelity). Ignored for non-PDF files.',
    }
  }

  if (isVisionCapable) {
    return {
      type: 'string',
      enum: ['text', 'image'],
      description:
        'PDF-only modality override. Omit for default (= "text"). "text" = plain text extraction. "image" = render the requested pages as images — opt in ONLY when text is insufficient (formulas, figures, scans, complex layout); avoid for large page ranges. Ignored for non-PDF files.',
    }
  }

  // Text-only model: no override is meaningful. Field is omitted from schema
  // entirely so the model has no decision to make.
  return undefined
}

const getOptionalIntegerArg = ({
  args,
  key,
  defaultValue,
  min,
  max,
}: {
  args: Record<string, unknown>
  key: string
  defaultValue: number
  min: number
  max: number
}): number => {
  const value = args[key]
  if (value === undefined) {
    return defaultValue
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`)
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}.`)
  }
  return value
}

export const getFsReadOperation = (
  args: Record<string, unknown>,
): FsReadOperation => {
  if (args.operation !== undefined || args.type !== undefined) {
    throw new Error(
      'fs_read uses flat range parameters. Omit range fields for a full read, or pass startLine with optional endLine or maxLines.',
    )
  }

  // Strict modality parsing: accept undefined / null / empty string (→ unset,
  // use default per active model) or one of 'text' / 'image' / 'pdf'. Numbers,
  // booleans, objects, arrays, and any other strings (including legacy 'auto')
  // all reject.
  //
  // The schema presented to the model is tailored per model capability
  // (see buildFsReadModalitySchema), so e.g. PDF-capable models only see
  // ['text','pdf']. The parser accepts the full superset because (a) it
  // doesn't have model context here, and (b) resolveModality below maps any
  // request to a sensible effective modality given the active model — a
  // model that somehow sends 'image' to a PDF-capable model gets upgraded to
  // native PDF rather than rejected, which is the more conservative path.
  const rawModalityValue = args.modality
  let modality: FsReadModality | undefined
  if (rawModalityValue !== undefined && rawModalityValue !== null) {
    if (typeof rawModalityValue !== 'string') {
      throw new Error(
        "modality must be 'text', 'image', or 'pdf' (or omitted for default behavior).",
      )
    }
    const normalized = rawModalityValue.trim().toLowerCase()
    if (normalized === '') {
      // Empty string is treated as "not provided" → default behavior.
    } else if (
      normalized === 'text' ||
      normalized === 'image' ||
      normalized === 'pdf'
    ) {
      modality = normalized
    } else {
      throw new Error(
        "modality must be 'text', 'image', or 'pdf' (or omitted for default behavior).",
      )
    }
  }

  let format: BrowserReadFormat | undefined
  const rawFormatValue = args.format
  if (rawFormatValue !== undefined && rawFormatValue !== null) {
    if (typeof rawFormatValue !== 'string') {
      throw new Error(
        "format must be 'readable' or 'key_visible_info' (or omitted).",
      )
    }
    const normalizedFormat = rawFormatValue.trim().toLowerCase()
    if (normalizedFormat === '') {
      // Empty string is treated as "not provided".
    } else if (
      normalizedFormat === 'readable' ||
      normalizedFormat === 'key_visible_info'
    ) {
      format = normalizedFormat
    } else {
      throw new Error(
        "format must be 'readable' or 'key_visible_info' (or omitted).",
      )
    }
  }

  const hasStartLine = args.startLine !== undefined
  const hasEndLine = args.endLine !== undefined
  const hasMaxLines = args.maxLines !== undefined
  const hasRange = hasStartLine || hasEndLine || hasMaxLines

  if (!hasRange) {
    return { type: 'full', modality, format }
  }

  if (!hasStartLine) {
    throw new Error('startLine is required when endLine or maxLines is set.')
  }
  if (hasEndLine && hasMaxLines) {
    throw new Error('endLine and maxLines cannot be used together.')
  }

  const startLine = getOptionalIntegerArg({
    args,
    key: 'startLine',
    defaultValue: DEFAULT_READ_START_LINE,
    min: 1,
    max: MAX_READ_LINE_INDEX,
  })
  const endLine = getOptionalBoundedIntegerArg({
    args,
    key: 'endLine',
    min: 1,
    max: MAX_READ_LINE_INDEX,
  })
  const maxLines = hasMaxLines
    ? getOptionalIntegerArg({
        args,
        key: 'maxLines',
        defaultValue: DEFAULT_READ_MAX_LINES,
        min: 1,
        max: MAX_READ_MAX_LINES,
      })
    : undefined

  if (endLine !== undefined && endLine < startLine) {
    throw new Error('endLine must be greater than or equal to startLine.')
  }
  if (endLine !== undefined && endLine - startLine + 1 > MAX_READ_MAX_LINES) {
    throw new Error(
      `Requested line range is too large. Maximum ${MAX_READ_MAX_LINES} lines per file.`,
    )
  }

  return {
    type: 'lines',
    startLine,
    endLine,
    maxLines,
    modality,
    format,
  }
}
