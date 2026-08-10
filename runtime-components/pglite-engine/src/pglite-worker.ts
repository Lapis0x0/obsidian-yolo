import { PGlite } from '@electric-sql/pglite'
import { worker } from '@electric-sql/pglite/worker'

worker({
  init: async (options: Record<string, unknown>) => {
    const vectorBlob = options._vectorExtensionBlob
    if (!(vectorBlob instanceof Blob)) {
      throw new Error('PGlite worker is missing the vector extension')
    }
    const { _vectorExtensionBlob: ignored, ...rest } = options
    void ignored
    return PGlite.create({
      ...rest,
      extensions: { vector: new URL(URL.createObjectURL(vectorBlob)) },
    })
  },
})
