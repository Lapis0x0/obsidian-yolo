import type { TextEditOperation, TextEditPlan } from './textEditEngine'

const ACTION_PATTERN = /^<<<<<<< (REPLACE|INSERT_AFTER|APPEND)\s*$/m

const normalizePlanSource = (content: string): string => {
  return content.replace(/\r\n/g, '\n').trim()
}

const parseReplaceOperation = (
  content: string,
): Extract<TextEditOperation, { type: 'replace' }> | null => {
  const match = content.match(
    /^<<<<<<< REPLACE\n(?:\[old\]\n)?([\s\S]*?)\n=======\n(?:\[(?:new|content)\]\n)?([\s\S]*?)\n>>>>>>> END$/,
  )
  if (!match) {
    return null
  }

  return {
    type: 'replace',
    oldText: match[1],
    newText: match[2],
  }
}

const parseInsertAfterOperation = (
  content: string,
): Extract<TextEditOperation, { type: 'insert_after' }> | null => {
  const match = content.match(
    /^<<<<<<< INSERT_AFTER\n(?:\[anchor\]\n)?([\s\S]*?)\n=======\n(?:\[(?:content|new)\]\n)?([\s\S]*?)\n>>>>>>> END$/,
  )
  if (!match) {
    return null
  }

  return {
    type: 'insert_after',
    anchor: match[1],
    content: match[2],
  }
}

const parseAppendOperation = (
  content: string,
): Extract<TextEditOperation, { type: 'append' }> | null => {
  const diffStyleMatch = content.match(
    /^<<<<<<< APPEND\n(?:([\s\S]*?)\n)?=======\n(?:\[(?:content|new)\]\n)?([\s\S]*?)\n>>>>>>> END$/,
  )
  if (diffStyleMatch) {
    return {
      type: 'append',
      content: diffStyleMatch[2],
    }
  }

  const directMatch = content.match(
    /^<<<<<<< APPEND\n(?:\[(?:content|new)\]\n)?([\s\S]*?)\n>>>>>>> END$/,
  )
  if (!directMatch) {
    return null
  }

  return {
    type: 'append',
    content: directMatch[1],
  }
}

export const parseTextEditPlan = (
  content: string,
  _options?: { requireDocumentType?: boolean },
): TextEditPlan | null => {
  const normalized = normalizePlanSource(content)
  if (!normalized) {
    return null
  }

  const operation =
    parseReplaceOperation(normalized) ??
    parseInsertAfterOperation(normalized) ??
    parseAppendOperation(normalized)

  if (!operation) {
    return null
  }

  return { operations: [operation] }
}

export const isTextEditPlanStreamingCandidate = (content: string): boolean => {
  return ACTION_PATTERN.test(content)
}

const extractReplacePreview = (content: string): string => {
  const startIndex = findPreviewStartIndex(content)
  if (startIndex === -1) {
    return ''
  }

  const previewStart = startIndex
  const endMarkerIndex = content.indexOf('\n>>>>>>> END', previewStart)
  const preview =
    endMarkerIndex === -1
      ? content.slice(previewStart)
      : content.slice(previewStart, endMarkerIndex)

  return preview.trim()
}

const extractInsertAfterPreview = (content: string): string => {
  const startIndex = findPreviewStartIndex(content)
  if (startIndex === -1) {
    return ''
  }

  const previewStart = startIndex
  const endMarkerIndex = content.indexOf('\n>>>>>>> END', previewStart)
  const preview =
    endMarkerIndex === -1
      ? content.slice(previewStart)
      : content.slice(previewStart, endMarkerIndex)

  return preview.trim()
}

const extractAppendPreview = (content: string): string => {
  const diffPreviewStartIndex = findPreviewStartIndex(content)
  if (diffPreviewStartIndex !== -1) {
    const endMarkerIndex = content.indexOf(
      '\n>>>>>>> END',
      diffPreviewStartIndex,
    )
    const preview =
      endMarkerIndex === -1
        ? content.slice(diffPreviewStartIndex)
        : content.slice(diffPreviewStartIndex, endMarkerIndex)

    return preview.trim()
  }

  const marker = '<<<<<<< APPEND\n'
  const startIndex = content.indexOf(marker)
  if (startIndex === -1) {
    return ''
  }

  const contentStart = startIndex + marker.length
  const previewStart = content.startsWith('[content]\n', contentStart)
    ? contentStart + '[content]\n'.length
    : content.startsWith('[new]\n', contentStart)
      ? contentStart + '[new]\n'.length
      : contentStart
  const endMarkerIndex = content.indexOf('\n>>>>>>> END', previewStart)
  const preview =
    endMarkerIndex === -1
      ? content.slice(previewStart)
      : content.slice(previewStart, endMarkerIndex)

  return preview.trim()
}

export const getStreamingTextEditPlanPreviewContent = (
  content: string,
): string => {
  const normalized = content.replace(/\r\n/g, '\n')

  if (normalized.includes('<<<<<<< REPLACE')) {
    return extractReplacePreview(normalized)
  }
  if (normalized.includes('<<<<<<< INSERT_AFTER')) {
    return extractInsertAfterPreview(normalized)
  }
  if (normalized.includes('<<<<<<< APPEND')) {
    return extractAppendPreview(normalized)
  }

  return ''
}

const findPreviewStartIndex = (content: string): number => {
  const markerIndex = content.indexOf('\n=======\n')
  if (markerIndex === -1) {
    return -1
  }

  const afterDividerIndex = markerIndex + '\n=======\n'.length
  if (content.startsWith('[new]\n', afterDividerIndex)) {
    return afterDividerIndex + '[new]\n'.length
  }
  if (content.startsWith('[content]\n', afterDividerIndex)) {
    return afterDividerIndex + '[content]\n'.length
  }

  return afterDividerIndex
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
