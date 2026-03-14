const isJsonObject = (value: unknown): value is Record<string, unknown> => {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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
  existingArgs?: string
  newArgs?: string
}): string | undefined => {
  if (!existingArgs && !newArgs) {
    return undefined
  }
  if (!existingArgs) {
    return newArgs
  }
  if (!newArgs) {
    return existingArgs
  }
  if (existingArgs === newArgs) {
    return existingArgs
  }

  const normalizedNew = parseJsonObjectText(newArgs)
  if (normalizedNew) {
    return JSON.stringify(normalizedNew)
  }

  const extractedFromNew = extractTopLevelJsonObjects(newArgs)
  if (extractedFromNew.length > 0) {
    return JSON.stringify(extractedFromNew[extractedFromNew.length - 1])
  }

  const normalizedExisting = parseJsonObjectText(existingArgs)
  if (normalizedExisting) {
    const concatenated = `${existingArgs}${newArgs}`
    const recoveredObjects = extractTopLevelJsonObjects(concatenated)
    if (recoveredObjects.length > 0) {
      return JSON.stringify(recoveredObjects[recoveredObjects.length - 1])
    }
    // Never downgrade from a previously valid JSON object to noisy partial text.
    return JSON.stringify(normalizedExisting)
  }

  if (newArgs.startsWith(existingArgs)) {
    return newArgs
  }
  if (existingArgs.startsWith(newArgs)) {
    return existingArgs
  }

  const concatenated = `${existingArgs}${newArgs}`
  const recoveredObjects = extractTopLevelJsonObjects(concatenated)
  if (recoveredObjects.length > 0) {
    return JSON.stringify(recoveredObjects[recoveredObjects.length - 1])
  }

  return concatenated
}
