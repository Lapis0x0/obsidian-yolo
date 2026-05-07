import type { RequestTransportMode } from '../../../types/provider.types'
import { createObsidianFetch } from '../../../utils/llm/obsidian-fetch'

export type DesktopNodeFetchOptions = {
  agent?: unknown
}

export const createDesktopNodeFetch = (
  _options: DesktopNodeFetchOptions = {},
): typeof fetch => {
  return async () => {
    throw new Error('Node request transport is not available in web runtime.')
  }
}

export const createSdkFetchForTransportMode = (
  mode: RequestTransportMode,
): typeof fetch | undefined => {
  if (mode === 'obsidian') {
    return createObsidianFetch()
  }

  if (mode === 'node') {
    return createDesktopNodeFetch()
  }

  return undefined
}
