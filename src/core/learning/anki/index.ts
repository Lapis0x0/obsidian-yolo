import { readAnkiArchive } from './archive'
import { initAnkiSqlite, parseAnkiDatabase } from './sqlite'
import type { AnkiImportResult, AnkiParseLimits } from './types'

export * from './types'

export const parseAnkiPackage = async (
  input: Uint8Array,
  options: {
    wasmBinary: Uint8Array
    limits?: Partial<AnkiParseLimits>
    now?: number
  },
): Promise<AnkiImportResult> => {
  const archive = await readAnkiArchive(input, options.limits)
  const SQL = await initAnkiSqlite(options.wasmBinary)
  return parseAnkiDatabase(
    SQL,
    archive.collection,
    archive.format,
    archive.media,
    options.now,
    archive.mediaFiles,
  )
}
