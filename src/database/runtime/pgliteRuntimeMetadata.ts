export type PGliteRuntimeFileName =
  | 'postgres.data'
  | 'postgres.wasm'
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

export const PGLITE_RUNTIME_VERSION = 'pglite-runtime-0.2.12-r1'

const RUNTIME_FILE_SPECS: Omit<PGliteRuntimeManifestFile, 'url'>[] = [
  {
    name: 'postgres.data',
    size: 2987805,
    sha256: '8bbecccbe044329462c8fd5148019ba0f82daa95e7f7737e2e71f9ce1f8c9528',
  },
  {
    name: 'postgres.wasm',
    size: 10551538,
    sha256: '6999f4a272f2c7a3ec9be4268f5c184dec973145ff0a3735b0f459a1a906e451',
  },
  {
    name: 'vector.tar.gz',
    size: 43910,
    sha256: 'd04da95473fd2706f2fe6147c260e2ed087fbe282791d0301a19ae89dcc5d5e1',
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
