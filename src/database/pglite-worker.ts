/**
 * PGlite worker entry: vector extension must be attached here (not on main thread)
 * because PGliteWorker rejects URL values in `extensions` on the client side.
 */
import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'

worker({
  // PGlite's worker init options are PGliteOptions plus custom fields; narrow at runtime.
  init: async (opts: Record<string, unknown>) => {
    const vectorBlob = opts._vectorExtensionBlob
    if (!(vectorBlob instanceof Blob)) {
      throw new Error('PGlite worker: missing _vectorExtensionBlob')
    }
    const { _vectorExtensionBlob: _ignored, ...rest } = opts
    const vectorExtensionBundlePath = new URL(URL.createObjectURL(vectorBlob))
    return PGlite.create({
      ...(rest as object),
      extensions: {
        vector: vectorExtensionBundlePath,
      },
    })
  },
})
