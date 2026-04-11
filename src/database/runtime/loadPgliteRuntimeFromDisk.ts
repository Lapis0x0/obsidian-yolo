import { App, normalizePath } from 'obsidian'

type DiskPgliteResources = {
  fsBundle: Blob
  pgliteWasmModule: WebAssembly.Module
  initdbWasmModule: WebAssembly.Module
  /** Raw gzip bytes for passing to PGlite worker (URL extensions not allowed on main thread). */
  vectorExtensionBlob: Blob
  vectorExtensionBundlePath: URL
}

export const loadPgliteRuntimeFromDisk = async (
  app: App,
  runtimeDir: string,
): Promise<DiskPgliteResources> => {
  const normalizedRuntimeDir = normalizePath(runtimeDir)
  const pgliteDataPath = normalizePath(`${normalizedRuntimeDir}/pglite.data`)
  const pgliteWasmPath = normalizePath(`${normalizedRuntimeDir}/pglite.wasm`)
  const initdbWasmPath = normalizePath(`${normalizedRuntimeDir}/initdb.wasm`)
  const vectorTarPath = normalizePath(`${normalizedRuntimeDir}/vector.tar.gz`)

  const [pgliteData, pgliteWasm, initdbWasm, vectorTar] = await Promise.all([
    app.vault.adapter.readBinary(pgliteDataPath),
    app.vault.adapter.readBinary(pgliteWasmPath),
    app.vault.adapter.readBinary(initdbWasmPath),
    app.vault.adapter.readBinary(vectorTarPath),
  ])

  const fsBundle = new Blob([pgliteData], {
    type: 'application/octet-stream',
  })
  const pgliteWasmModule = await WebAssembly.compile(pgliteWasm)
  const initdbWasmModule = await WebAssembly.compile(initdbWasm)
  const vectorBlob = new Blob([vectorTar], {
    type: 'application/gzip',
  })
  const vectorExtensionBundlePath = new URL(URL.createObjectURL(vectorBlob))

  return {
    fsBundle,
    pgliteWasmModule,
    initdbWasmModule,
    vectorExtensionBlob: vectorBlob,
    vectorExtensionBundlePath,
  }
}
