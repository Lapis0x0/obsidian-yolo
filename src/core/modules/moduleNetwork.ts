// What a module may ask of the web: a resource's bytes, fetched through
// Obsidian (`requestUrl`), which no site's CORS policy applies to. A page may
// show another site's image but not read it — a canvas it is drawn into can
// no longer be read, nor uploaded to the GPU — so what a module has to draw
// itself, or keep, it fetches here instead.

import {
  type RequestUrlParam,
  type RequestUrlResponse,
  requestUrl,
} from 'obsidian'

import type { ModuleLifecycleScope } from './lifecycleScope'
import type { YoloModuleNetworkResponseV1, YoloModuleNetworkV1 } from './types'

export type ModuleNetworkCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): Readonly<{ api: YoloModuleNetworkV1 }>
}

export const UNAVAILABLE_MODULE_NETWORK_CAPABILITY_PROVIDER: ModuleNetworkCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: Object.freeze({
        requestBinary: async (): Promise<never> => {
          throw new Error('Module network capability is unavailable')
        },
      }),
    }),
  })

export class ModuleNetworkCapabilityProvider
  implements ModuleNetworkCapabilityProviderV1
{
  constructor(
    private readonly request: (
      param: RequestUrlParam,
    ) => Promise<RequestUrlResponse> = requestUrl,
  ) {}

  create(
    _moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): Readonly<{ api: YoloModuleNetworkV1 }> {
    let disposed = false
    lifecycle.add(() => {
      disposed = true
    })
    const request = this.request
    return Object.freeze({
      api: Object.freeze({
        requestBinary: async (
          url: string,
        ): Promise<YoloModuleNetworkResponseV1> => {
          if (disposed) throw new Error('Module network capability is disposed')
          let parsed: URL
          try {
            parsed = new URL(url)
          } catch {
            throw new Error(`Not a web address: ${url}`)
          }
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new Error(`Not a web address: ${url}`)
          }
          const response = await request({
            url: parsed.href,
            method: 'GET',
            throw: false,
          })
          if (response.status < 200 || response.status >= 300) {
            throw new Error(`Request failed with status ${response.status}`)
          }
          return Object.freeze({
            contentType: headerOf(response.headers, 'content-type'),
            body: response.arrayBuffer,
          })
        },
      }),
    })
  }
}

function headerOf(
  headers: Record<string, string>,
  name: string,
): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return null
}
