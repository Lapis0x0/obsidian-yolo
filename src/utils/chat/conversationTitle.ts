import { LEGACY_UNTITLED_CONVERSATION_TITLES } from '../../constants'

const LEGACY_UNTITLED_TITLE_SET = new Set<string>(
  LEGACY_UNTITLED_CONVERSATION_TITLES,
)

export const isUntitledConversationTitle = (
  title: string | null | undefined,
): boolean => {
  const normalized = title?.trim() ?? ''
  return normalized.length === 0 || LEGACY_UNTITLED_TITLE_SET.has(normalized)
}

export const getConversationDisplayTitle = (
  title: string | null | undefined,
  fallback: string,
): string => (isUntitledConversationTitle(title) ? fallback : title!.trim())

/**
 * Return a generated title only when it is still allowed to replace the
 * current local title. A manual title always wins unless generation was
 * explicitly retried by the user.
 */
export const getGeneratedTitleToApply = ({
  currentTitle,
  generatedTitle,
  force = false,
}: {
  currentTitle: string | null | undefined
  generatedTitle: string
  force?: boolean
}): string | null =>
  force || isUntitledConversationTitle(currentTitle) ? generatedTitle : null
