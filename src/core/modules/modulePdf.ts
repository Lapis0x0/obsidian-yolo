import type {
  PdfDocumentCache,
  PdfDocumentHandle,
} from '../../utils/pdf/pdfDocumentCache'
import type { PdfAnnotationInput } from '../runtime-components/contracts'

import type { ModuleLifecycleScope } from './lifecycleScope'
import { normalizeModuleVaultPath } from './moduleVault'
import type {
  YoloModulePdfAnnotationV1,
  YoloModulePdfDocumentV1,
  YoloModulePdfV1,
} from './types'

export type ModulePdfCapabilityActivationV1 = Readonly<{
  api: YoloModulePdfV1
  activate(): void
}>

export type ModulePdfCapabilityProviderV1 = {
  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModulePdfCapabilityActivationV1
}

export const UNAVAILABLE_MODULE_PDF_CAPABILITY_PROVIDER: ModulePdfCapabilityProviderV1 =
  Object.freeze({
    create: () => ({
      api: Object.freeze({
        open: () => Promise.reject(new Error('Module PDF is unavailable')),
        addAnnotations: () =>
          Promise.reject(new Error('Module PDF is unavailable')),
      }),
      activate: () => undefined,
    }),
  })

/**
 * The module-facing view of the host's shared PDF documents: the same cache
 * the host would use itself, with every handle a module opens tracked so an
 * unloading module cannot keep a document (and the engine) alive.
 */
export class ModulePdfCapabilityProvider
  implements ModulePdfCapabilityProviderV1
{
  constructor(
    private readonly getDocuments: () => Pick<PdfDocumentCache, 'open'>,
    private readonly addAnnotations: (
      bytes: Uint8Array,
      annotations: readonly PdfAnnotationInput[],
    ) => Promise<Uint8Array>,
  ) {}

  create(
    moduleId: string,
    lifecycle: ModuleLifecycleScope,
  ): ModulePdfCapabilityActivationV1 {
    const handles = new Set<PdfDocumentHandle>()
    let active = true
    lifecycle.add(() => {
      active = false
      for (const handle of handles) handle.release()
      handles.clear()
    })
    const assertActive = (): void => {
      if (!active) throw new Error(`Module "${moduleId}" PDF is not active`)
    }

    return Object.freeze({
      api: Object.freeze({
        open: async (filePath: string): Promise<YoloModulePdfDocumentV1> => {
          assertActive()
          const path = normalizeModuleVaultPath(filePath)
          const handle = await this.getDocuments().open(path)
          if (!active) {
            handle.release()
            assertActive()
          }
          handles.add(handle)
          return Object.freeze({
            path: handle.path,
            pageCount: handle.pageCount,
            getPage: handle.getPage,
            isStale: handle.isStale,
            subscribe: handle.subscribe,
            release: () => {
              handles.delete(handle)
              handle.release()
            },
          })
        },
        addAnnotations: async (
          pdf: ArrayBuffer,
          annotations: readonly YoloModulePdfAnnotationV1[],
        ): Promise<ArrayBuffer> => {
          assertActive()
          if (!(pdf instanceof ArrayBuffer)) {
            throw new TypeError('Module PDF bytes must be an ArrayBuffer')
          }
          if (!Array.isArray(annotations)) {
            throw new TypeError('Module PDF annotations must be an array')
          }
          const output = await this.addAnnotations(
            new Uint8Array(pdf),
            annotations,
          )
          assertActive()
          // An ArrayBuffer of exactly the output, not a view's whole buffer.
          return output.buffer.slice(
            output.byteOffset,
            output.byteOffset + output.byteLength,
          )
        },
      }),
      activate: () => undefined,
    })
  }
}
