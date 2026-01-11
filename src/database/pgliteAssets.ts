declare const __PGLITE_POSTGRES_DATA__: string
declare const __PGLITE_POSTGRES_WASM__: string
declare const __PGLITE_VECTOR_TAR__: string

const postgresDataBase64 = __PGLITE_POSTGRES_DATA__
const postgresWasmBase64 = __PGLITE_POSTGRES_WASM__
const vectorTarBase64 = __PGLITE_VECTOR_TAR__

type EmbeddedPgliteResources = {
  fsBundle: Blob
  wasmModule: WebAssembly.Module
  vectorExtensionBundlePath: URL
}

const decodeBase64ToBytes = (input: string): Uint8Array => {
  const base64 = input.includes(',') ? (input.split(',')[1] ?? '') : input
  const binary = atob(base64)
  const length = binary.length
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

let embeddedResourcesPromise: Promise<EmbeddedPgliteResources> | null = null

export const loadEmbeddedPgliteResources =
  async (): Promise<EmbeddedPgliteResources> => {
    if (!embeddedResourcesPromise) {
      embeddedResourcesPromise = (async () => {
        const fsBundle = new Blob([decodeBase64ToBytes(postgresDataBase64)], {
          type: 'application/octet-stream',
        })
        const wasmBytes = decodeBase64ToBytes(postgresWasmBase64)
        const wasmModule = await WebAssembly.compile(wasmBytes)
        const vectorBlob = new Blob([decodeBase64ToBytes(vectorTarBase64)], {
          type: 'application/gzip',
        })
        const vectorExtensionBundlePath = new URL(
          URL.createObjectURL(vectorBlob),
        )

        return { fsBundle, wasmModule, vectorExtensionBundlePath }
      })()
    }

    return embeddedResourcesPromise
  }
