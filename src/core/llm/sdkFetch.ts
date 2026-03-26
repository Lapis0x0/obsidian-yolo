import { Platform } from 'obsidian'
import type { RequestOptions } from 'node:http'

import type { RequestTransportMode } from '../../types/provider.types'
import { createObsidianFetch } from '../../utils/llm/obsidian-fetch'

let nodeFetchPromise: Promise<typeof fetch> | null = null

type NodeFetchRequestInit = RequestInit & {
  agent?: RequestOptions['agent']
}

export type DesktopNodeFetchOptions = {
  agent?: RequestOptions['agent']
}

const loadNodeFetch = async (): Promise<typeof fetch> => {
  if (!nodeFetchPromise) {
    nodeFetchPromise = import('node-fetch/lib/index.js').then(
      (module) =>
        ((module as unknown as { default?: typeof fetch }).default ??
          module) as unknown as typeof fetch,
    )
  }

  return nodeFetchPromise
}

export const createDesktopNodeFetch = (
  options: DesktopNodeFetchOptions = {},
): typeof fetch => {
  return async (input, init) => {
    if (!Platform.isDesktop) {
      throw new Error(
        'Node request transport is only available on desktop Obsidian.',
      )
    }

    const nodeFetch = await loadNodeFetch()
    const baseInit = init as NodeFetchRequestInit | undefined
    const requestInit: NodeFetchRequestInit | undefined = init
      ? {
          ...init,
          agent: baseInit?.agent ?? options.agent,
        }
      : options.agent
        ? { agent: options.agent }
        : undefined

    return nodeFetch(input, requestInit)
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
