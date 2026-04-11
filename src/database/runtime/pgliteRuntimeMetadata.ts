export type PGliteRuntimeFileName =
  | 'pglite.data'
  | 'pglite.wasm'
  | 'initdb.wasm'
  | 'vector.tar.gz'

export type PGliteRuntimeManifestFile = {
  name: PGliteRuntimeFileName
  size: number
  sha256: string
  url: string
}

export type PGliteRuntimeManifest = {
  runtimeVersion: string
  files: PGliteRuntimeManifestFile[]
}

/** Bump when shipping new @electric-sql/pglite WASM bundles (see releases on origin repo). */
export const PGLITE_RUNTIME_VERSION = 'pglite-runtime-0.4.4-r1'

const RUNTIME_FILE_SPECS: Omit<PGliteRuntimeManifestFile, 'url'>[] = [
  {
    name: 'pglite.data',
    size: 5289109,
    sha256:
      '4507d476e23421aab8201ee9d58059c53736db40e1bfe5d14bb86124e59a116d',
  },
  {
    name: 'pglite.wasm',
    size: 8739902,
    sha256:
      '551cf9bcfb34e4b0ea118b8e658b5e3e85b20d620a6f365239ce02f32ffc20e9',
  },
  {
    name: 'initdb.wasm',
    size: 169969,
    sha256:
      '13ed8475e33d092d03e2378d6b78d52da0c4d497b1df2c2a62d33fe32ceb67e2',
  },
  {
    name: 'vector.tar.gz',
    size: 46052,
    sha256:
      '3d968eee93191a2a0073b8c18a773c8aa315f4d4b4734cf5ff5e1fe6d100485b',
  },
]

const GITHUB_RELEASE_BASE =
  'https://github.com/Lapis0x0/obsidian-yolo/releases/download'

export const createPGliteRuntimeManifest = (
  runtimeVersion: string = PGLITE_RUNTIME_VERSION,
): PGliteRuntimeManifest => {
  return {
    runtimeVersion,
    files: RUNTIME_FILE_SPECS.map((file) => ({
      ...file,
      url: `${GITHUB_RELEASE_BASE}/${runtimeVersion}/${file.name}`,
    })),
  }
}
