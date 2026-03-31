import { App, normalizePath } from 'obsidian'

type DiskPgliteResources = {
  fsBundle: Blob
  wasmModule: WebAssembly.Module
  vectorExtensionBundlePath: URL
}

export const loadPgliteRuntimeFromDisk = async (
  app: App,
  runtimeDir: string,
): Promise<DiskPgliteResources> => {
  const normalizedRuntimeDir = normalizePath(runtimeDir)
  const postgresDataPath = normalizePath(
    `${normalizedRuntimeDir}/postgres.data`,
  )
  const postgresWasmPath = normalizePath(
    `${normalizedRuntimeDir}/postgres.wasm`,
  )
  const vectorTarPath = normalizePath(`${normalizedRuntimeDir}/vector.tar.gz`)

  const [postgresData, postgresWasm, vectorTar] = await Promise.all([
    app.vault.adapter.readBinary(postgresDataPath),
    app.vault.adapter.readBinary(postgresWasmPath),
    app.vault.adapter.readBinary(vectorTarPath),
  ])

  const fsBundle = new Blob([postgresData], {
    type: 'application/octet-stream',
  })
  const wasmModule = await WebAssembly.compile(postgresWasm)
  const vectorBlob = new Blob([vectorTar], {
    type: 'application/gzip',
  })
  const vectorExtensionBundlePath = new URL(URL.createObjectURL(vectorBlob))

  return { fsBundle, wasmModule, vectorExtensionBundlePath }
}
