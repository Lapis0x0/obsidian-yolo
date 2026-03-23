import { Platform } from 'obsidian'

import type { RequestTransportMode } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'

let nodeFetchPromise: Promise<typeof fetch> | null = null

const loadNodeFetch = async (): Promise<typeof fetch> => {
  if (!nodeFetchPromise) {
    nodeFetchPromise = import('node-fetch/lib/index.js').then(
      (module) =>
        (((module as unknown as { default?: typeof fetch }).default ??
          module) as unknown as typeof fetch),
    )
  }

  return nodeFetchPromise
}

export const createDesktopNodeFetch = (): typeof fetch => {
  return async (input, init) => {
    if (!Platform.isDesktop) {
      throw new Error(
        'Node request transport is only available on desktop Obsidian.',
      )
    }

    const nodeFetch = await loadNodeFetch()
    return nodeFetch(input, init)
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
