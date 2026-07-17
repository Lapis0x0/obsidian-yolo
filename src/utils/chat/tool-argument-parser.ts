import {
  type ToolCallArguments,
  createCompleteToolCallArguments,
  getToolCallArgumentsText,
  isToolCallArgumentsRecord,
} from '../../types/tool-call.types'

export type ToolArgumentParseResult =
  | {
      ok: true
      arguments: ToolCallArguments
      value: Record<string, unknown>
      repairApplied: boolean
      repairActions: string[]
    }
  | {
      ok: false
      error: string
      providedParameterNames: string[]
      rawArgsLength: number
      rawArgsHead: string
      repairActions: string[]
    }

const RAW_HEAD_LENGTH = 240

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

const tryParseJsonObject = (
  text: string,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string } => {
  try {
    const parsed = JSON.parse(text)
    if (!isToolCallArgumentsRecord(parsed)) {
      return {
        ok: false,
        error: `Expected a JSON object, received ${Array.isArray(parsed) ? 'array' : typeof parsed}.`,
      }
    }
    return { ok: true, value: parsed }
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) }
  }
}

const extractProvidedParameterNames = (text: string): string[] => {
  const names = new Set<string>()
  const keyPattern = /"((?:[^"\\]|\\.)*)"\s*:/g
  let match: RegExpExecArray | null
  while ((match = keyPattern.exec(text)) !== null) {
    const rawKey = match[1]
    try {
      const parsed = JSON.parse(`"${rawKey}"`)
      if (typeof parsed === 'string' && parsed.length > 0) {
        names.add(parsed)
      }
    } catch {
      if (rawKey.length > 0) {
        names.add(rawKey)
      }
    }
  }
  return [...names].sort()
}

const trimCodeFence = (text: string): { text: string; action?: string } => {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (!match) {
    return { text }
  }
  return { text: match[1], action: 'removed surrounding code fence' }
}

const trimXmlWrapper = (text: string): { text: string; action?: string } => {
  const match = text.match(/^<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>([\s\S]*)<\/\1>$/)
  if (!match) {
    return { text }
  }
  return { text: match[2].trim(), action: 'removed surrounding XML wrapper' }
}

const sliceToLikelyJsonObject = (
  text: string,
): { text: string; action?: string } => {
  const firstBrace = text.indexOf('{')
  if (firstBrace <= 0) {
    return { text }
  }
  return {
    text: text.slice(firstBrace),
    action: 'removed leading non-JSON text before object start',
  }
}

const cleanupCommas = (text: string): { text: string; actions: string[] } => {
  const actions: string[] = []
  let next = text.replace(/,\s*,+/g, ',')
  if (next !== text) {
    actions.push('collapsed duplicated commas')
  }
  const beforeTrailing = next
  next = next.replace(/,\s*([}\]])/g, '$1')
  if (next !== beforeTrailing) {
    actions.push('removed trailing commas')
  }
  return { text: next, actions }
}

const closeJsonStructure = (
  text: string,
): { text: string; actions: string[] } => {
  const stack: string[] = []
  let inString = false
  let escaped = false

  for (const char of text) {
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      stack.push('}')
      continue
    }
    if (char === '[') {
      stack.push(']')
      continue
    }
    if ((char === '}' || char === ']') && stack.at(-1) === char) {
      stack.pop()
    }
  }

  const actions: string[] = []
  let next = text
  if (inString) {
    next += '"'
    actions.push('closed unterminated string')
  }
  if (stack.length > 0) {
    next += stack.reverse().join('')
    actions.push('closed unbalanced JSON structure')
  }

  return { text: next, actions }
}

const repairJsonText = (
  rawText: string,
): { text: string; actions: string[] } => {
  const actions: string[] = []
  let text = rawText.trim()

  const fenced = trimCodeFence(text)
  text = fenced.text.trim()
  if (fenced.action) actions.push(fenced.action)

  const wrapped = trimXmlWrapper(text)
  text = wrapped.text.trim()
  if (wrapped.action) actions.push(wrapped.action)

  const sliced = sliceToLikelyJsonObject(text)
  text = sliced.text.trim()
  if (sliced.action) actions.push(sliced.action)

  const commaCleaned = cleanupCommas(text)
  text = commaCleaned.text
  actions.push(...commaCleaned.actions)

  const closed = closeJsonStructure(text)
  text = closed.text
  actions.push(...closed.actions)

  const finalCommaCleaned = cleanupCommas(text)
  text = finalCommaCleaned.text
  actions.push(...finalCommaCleaned.actions)

  return { text, actions }
}

export const parseAndRepairToolArgumentsText = (
  rawText: string,
): ToolArgumentParseResult => {
  const rawArgsLength = rawText.length
  const rawArgsHead = rawText.slice(0, RAW_HEAD_LENGTH)
  const trimmed = rawText.trim()
  const initial = tryParseJsonObject(trimmed)
  if (initial.ok) {
    return {
      ok: true,
      arguments: createCompleteToolCallArguments({
        value: initial.value,
        rawText,
      }),
      value: initial.value,
      repairApplied: false,
      repairActions: [],
    }
  }

  const repaired = repairJsonText(rawText)
  if (repaired.actions.length > 0 && repaired.text !== trimmed) {
    const repairedParse = tryParseJsonObject(repaired.text)
    if (repairedParse.ok) {
      return {
        ok: true,
        arguments: createCompleteToolCallArguments({
          value: repairedParse.value,
          rawText,
        }),
        value: repairedParse.value,
        repairApplied: true,
        repairActions: repaired.actions,
      }
    }
    return {
      ok: false,
      error: repairedParse.error,
      providedParameterNames: extractProvidedParameterNames(rawText),
      rawArgsLength,
      rawArgsHead,
      repairActions: repaired.actions,
    }
  }

  return {
    ok: false,
    error: initial.error,
    providedParameterNames: extractProvidedParameterNames(rawText),
    rawArgsLength,
    rawArgsHead,
    repairActions: repaired.actions,
  }
}

export const parseAndRepairToolArguments = (
  args: ToolCallArguments,
): ToolArgumentParseResult => {
  if (args.kind === 'complete') {
    return {
      ok: true,
      arguments: args,
      value: args.value,
      repairApplied: false,
      repairActions: [],
    }
  }

  return parseAndRepairToolArgumentsText(getToolCallArgumentsText(args) ?? '')
}
