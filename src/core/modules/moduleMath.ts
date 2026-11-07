// What a module may ask of formulas: TeX laid out as Obsidian lays it out in
// a note — the same MathJax, font and packages — as shapes the module draws
// itself, for a view that draws its own text rather than building a note's
// DOM (the whiteboard's GPU-drawn cards). The work is the math engine's
// (runtime component `mathjax-engine`), installed on first use; a module
// never holds its code, only what it lays out.

import {
  type MathRequest,
  type RuntimeComponentLease,
} from '../runtime-components/contracts'
import { acquireRuntimeComponent } from '../runtime-components/runtimeComponentAccess'

import type { ModuleLifecycleScope } from './lifecycleScope'
import type { YoloModuleMathLayoutV1, YoloModuleMathV1 } from './types'

export type ModuleMathCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): Readonly<{ api: YoloModuleMathV1 }>
}

export const UNAVAILABLE_MODULE_MATH_CAPABILITY_PROVIDER: ModuleMathCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: Object.freeze({
        layout: async (): Promise<never> => {
          throw new Error('Module math capability is unavailable')
        },
      }),
    }),
  })

export class ModuleMathCapabilityProvider
  implements ModuleMathCapabilityProviderV1
{
  constructor(
    private readonly acquire: () => Promise<
      RuntimeComponentLease<'mathjax-engine'>
    > = () => acquireRuntimeComponent('mathjax-engine'),
  ) {}

  create(
    _moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): Readonly<{ api: YoloModuleMathV1 }> {
    let disposed = false
    lifecycle.add(() => {
      disposed = true
    })
    const assertActive = (): void => {
      if (disposed) throw new Error('Module math capability is disposed')
    }
    return Object.freeze({
      api: Object.freeze({
        layout: async (
          requests: readonly MathRequest[],
        ): Promise<readonly (YoloModuleMathLayoutV1 | null)[]> => {
          assertActive()
          if (!Array.isArray(requests)) {
            throw new TypeError('Module math requests must be an array')
          }
          const copied = requests.map((request: unknown) => {
            const { tex, display } = (request ?? {}) as Partial<MathRequest>
            if (typeof tex !== 'string' || typeof display !== 'boolean') {
              throw new TypeError(
                'A module math request is { tex: string, display: boolean }',
              )
            }
            return { tex, display }
          })
          if (copied.length === 0) return []
          const lease = await this.acquire()
          try {
            const layouts = await lease.api.layout(copied)
            assertActive()
            return layouts
          } finally {
            lease.release()
          }
        },
      }),
    })
  }
}
