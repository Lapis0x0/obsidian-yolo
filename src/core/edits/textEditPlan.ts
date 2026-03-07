import type { TextEditOperation, TextEditPlan } from './textEditEngine'

import {
  extractTopLevelJsonObjects,
  parseJsonObjectText,
} from '../../utils/chat/tool-arguments'

export const TEXT_EDIT_PLAN_TYPE = 'text_edit_plan'
export const TEXT_EDIT_PLAN_VERSION = 1

const TEXT_EDIT_PLAN_TYPE_PATTERN = new RegExp(
  `"type"\\s*:\\s*"${TEXT_EDIT_PLAN_TYPE}"`,
  'i',
)
const PREVIEW_VALUE_PATTERN = /"(?:newText|content|replace)"\s*:\s*"/gi

type JsonObject = Record<string, unknown>

const asObject = (value: unknown): JsonObject | null => {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return null
  }
  return value as JsonObject
}

const asPositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  const normalized = Math.floor(value)
  return normalized > 0 ? normalized : undefined
}

const getString = (record: JsonObject, key: string): string => {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

const normalizeOperation = (value: unknown): TextEditOperation | null => {
  const record = asObject(value)
  if (!record) {
    return null
  }

  const rawType = getString(record, 'type').trim().toLowerCase()
  if (rawType === 'replace') {
    return {
      type: 'replace',
      oldText: getString(record, 'oldText') || getString(record, 'search'),
      newText: getString(record, 'newText') || getString(record, 'replace'),
      expectedOccurrences:
        asPositiveInteger(record.expectedOccurrences) ??
        asPositiveInteger(record.occurrences),
    }
  }

  if (rawType === 'insert_after' || rawType === 'insertafter') {
    return {
      type: 'insert_after',
      anchor: getString(record, 'anchor') || getString(record, 'oldText'),
      content: getString(record, 'content') || getString(record, 'newText'),
      expectedOccurrences:
        asPositiveInteger(record.expectedOccurrences) ??
        asPositiveInteger(record.occurrences),
    }
  }

  if (rawType === 'append' || rawType === 'continue') {
    return {
      type: 'append',
      content: getString(record, 'content') || getString(record, 'newText'),
    }
  }

  return null
}

const parseRootObject = (content: string): JsonObject | null => {
  const trimmed = content.trim()
  if (!trimmed) {
    return null
  }

  return (
    parseJsonObjectText(trimmed) ??
    extractTopLevelJsonObjects(trimmed)[0] ??
    null
  )
}

export const parseTextEditPlan = (
  content: string,
  options?: { requireDocumentType?: boolean },
): TextEditPlan | null => {
  const root = parseRootObject(content)
  if (!root) {
    return null
  }

  if (options?.requireDocumentType) {
    if (getString(root, 'type') !== TEXT_EDIT_PLAN_TYPE) {
      return null
    }
    const rawVersion = root.version
    if (
      typeof rawVersion !== 'number' ||
      !Number.isFinite(rawVersion) ||
      rawVersion < TEXT_EDIT_PLAN_VERSION
    ) {
      return null
    }
  }

  const operationsValue = Array.isArray(root.operations)
    ? root.operations
    : Array.isArray(root.edits)
      ? root.edits
      : null
  if (!operationsValue) {
    return null
  }

  const operations = operationsValue
    .map((item) => normalizeOperation(item))
    .filter((item): item is TextEditOperation => Boolean(item))

  if (operations.length === 0) {
    return null
  }

  return { operations }
}

export const isTextEditPlanStreamingCandidate = (content: string): boolean => {
  return TEXT_EDIT_PLAN_TYPE_PATTERN.test(content)
}

const decodePartialJsonString = (rawValue: string): string => {
  let decoded = ''

  for (let index = 0; index < rawValue.length; index += 1) {
    const currentChar = rawValue[index]
    if (currentChar !== '\\') {
      decoded += currentChar
      continue
    }

    const nextChar = rawValue[index + 1]
    if (!nextChar) {
      break
    }

    if (nextChar === 'u') {
      const unicodeHex = rawValue.slice(index + 2, index + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(unicodeHex)) {
        break
      }
      decoded += String.fromCharCode(parseInt(unicodeHex, 16))
      index += 5
      continue
    }

    if (nextChar === 'n') {
      decoded += '\n'
    } else if (nextChar === 'r') {
      decoded += '\r'
    } else if (nextChar === 't') {
      decoded += '\t'
    } else if (nextChar === 'b') {
      decoded += '\b'
    } else if (nextChar === 'f') {
      decoded += '\f'
    } else {
      decoded += nextChar
    }

    index += 1
  }

  return decoded
}

const extractStreamingJsonStringValue = (
  content: string,
  startIndex: number,
): string => {
  let escaped = false
  let rawValue = ''

  for (let index = startIndex; index < content.length; index += 1) {
    const currentChar = content[index]
    if (!escaped && currentChar === '"') {
      return decodePartialJsonString(rawValue)
    }

    rawValue += currentChar
    if (escaped) {
      escaped = false
      continue
    }

    escaped = currentChar === '\\'
  }

  return decodePartialJsonString(rawValue)
}

export const getStreamingTextEditPlanPreviewContent = (
  content: string,
): string => {
  const previewChunks: string[] = []
  PREVIEW_VALUE_PATTERN.lastIndex = 0

  let match = PREVIEW_VALUE_PATTERN.exec(content)
  while (match) {
    const extracted = extractStreamingJsonStringValue(
      content,
      match.index + match[0].length,
    ).trim()

    if (extracted.length > 0) {
      previewChunks.push(extracted)
    }

    match = PREVIEW_VALUE_PATTERN.exec(content)
  }

  return previewChunks.join('\n\n')
}

export const getTextEditPlanPreviewContent = (plan: TextEditPlan): string => {
  return plan.operations
    .map((operation) => {
      if (operation.type === 'replace') {
        return operation.newText
      }
      return operation.content
    })
    .filter((content) => content.length > 0)
    .join('\n\n')
}
