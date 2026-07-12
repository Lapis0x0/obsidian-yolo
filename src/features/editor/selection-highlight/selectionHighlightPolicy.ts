import { Platform } from 'obsidian'

export type HighlightOwner = 'chat' | 'quickask' | 'transient'

export function shouldCreateSelectionHighlight(
  owner: HighlightOwner,
  isMobile = Platform.isMobile,
): boolean {
  return !isMobile || owner === 'transient'
}
