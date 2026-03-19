import {
  type ToolCallArguments,
  createCompleteToolCallArguments,
  createPartialToolCallArguments,
  getToolCallArgumentsText,
  isToolCallArgumentsRecord,
} from '../../types/tool-call.types'

const isJsonObject = (value: unknown): value is Record<string, unknown> => {
  return isToolCallArgumentsRecord(value)
}

export const parseJsonObjectText = (
  text: string,
): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text)
    return isJsonObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const extractTopLevelJsonObjects = (
  text: string,
): Record<string, unknown>[] => {
  const results: Record<string, unknown>[] = []

  let depth = 0
  let inString = false
  let escaped = false
  let objectStart = -1

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

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
      if (depth === 0) {
        objectStart = i
      }
      depth += 1
      continue
    }

    if (char === '}') {
      if (depth === 0) {
        continue
      }
      depth -= 1
      if (depth === 0 && objectStart >= 0) {
        const candidate = text.slice(objectStart, i + 1)
        const parsed = parseJsonObjectText(candidate)
        if (parsed) {
          results.push(parsed)
        }
        objectStart = -1
      }
    }
  }

  return results
}

export const mergeStreamingToolArguments = ({
  existingArgs,
  newArgs,
}: {
  existingArgs?: ToolCallArguments
  newArgs?: string
}): ToolCallArguments | undefined => {
  if (!existingArgs && !newArgs) {
    return undefined
  }
  if (!existingArgs) {
    return createToolCallArguments(newArgs, { allowPartial: true })
  }
  if (!newArgs) {
    return existingArgs
  }
  const existingText = getToolCallArgumentsText(existingArgs)
  if (existingText === newArgs) {
    return existingArgs
  }

  const candidate = (() => {
    if (!existingText || existingText.length === 0) {
      return newArgs
    }
    if (newArgs.startsWith(existingText)) {
      return newArgs
    }
    if (existingText.startsWith(newArgs)) {
      return existingText
    }
    return `${existingText}${newArgs}`
  })()

  const recovered = createToolCallArguments(candidate, { allowPartial: true })
  if (recovered?.kind === 'complete') {
    return recovered
  }

  if (existingArgs.kind === 'complete') {
    return existingArgs
  }

  return recovered
}

export const createToolCallArguments = (
  rawText: string | undefined,
  options?: { allowPartial?: boolean },
): ToolCallArguments | undefined => {
  if (!rawText) {
    return undefined
  }

  const trimmed = rawText.trim()
  if (trimmed.length === 0) {
    return undefined
  }

  const parsed = parseJsonObjectText(trimmed)
  if (parsed) {
    return createCompleteToolCallArguments({
      value: parsed,
      rawText,
    })
  }

  const recoveredObjects = extractTopLevelJsonObjects(trimmed)
  if (recoveredObjects.length > 0) {
    return createCompleteToolCallArguments({
      value: recoveredObjects[recoveredObjects.length - 1],
      rawText,
    })
  }

  if (options?.allowPartial) {
    return createPartialToolCallArguments(rawText)
  }

  return undefined
}
