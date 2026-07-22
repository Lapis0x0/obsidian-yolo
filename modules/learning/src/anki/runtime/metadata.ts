export type AnkiRuntimeManifest = {
  runtimeVersion: string
  files: { name: 'sql-wasm.wasm'; size: number; sha256: string; url: string }[]
}

export const ANKI_SQLITE_RUNTIME_VERSION = 'anki-sqlite-runtime-1.13.0-r1'

export const createAnkiRuntimeManifest = (
  runtimeVersion = ANKI_SQLITE_RUNTIME_VERSION,
): AnkiRuntimeManifest => ({
  runtimeVersion,
  files: [
    {
      name: 'sql-wasm.wasm',
      size: 659806,
      sha256:
        '0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73',
      url: `https://github.com/Lapis0x0/obsidian-yolo/releases/download/${runtimeVersion}/sql-wasm.wasm`,
    },
  ],
})
