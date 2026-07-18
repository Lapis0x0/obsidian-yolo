import type { SrsCardState, SrsProjectState } from '../../domain/srs/srsTypes'

export type AnkiRatingEvent = Readonly<{
  cardId: number
  reviewedAt: number
  rating: 1 | 2 | 3 | 4
  intervalDays: number
}>

export type ParsedAnkiCard = Readonly<{
  id: number
  noteId: number
  deckId: number
  templateOrdinal: number
  front: string
  back: string
  queue: number
  suspended: boolean
}>

export type ParsedAnkiImport = Readonly<{
  format: 'legacy' | 'modern'
  decks: readonly Readonly<{ id: number; name: string; path: string[] }>[]
  notes: readonly Readonly<{ cards: readonly ParsedAnkiCard[] }>[]
  mediaFiles: Readonly<Record<string, Uint8Array>>
  srsPlan: Readonly<{
    eventsByCard: Readonly<Record<string, readonly AnkiRatingEvent[]>>
  }>
  warnings: readonly string[]
}>

export type AnkiSrsReplayPort = {
  replay(events: readonly AnkiRatingEvent[], introducedAt: Date): SrsCardState
}

export type AnkiImportVaultPort = {
  exists(path: string): Promise<boolean>
  readText(path: string): Promise<string>
  readBinary(path: string): Promise<ArrayBuffer>
  ensureFolder(path: string): Promise<void>
  createFolder(path: string): Promise<void>
  createText(path: string, content: string): Promise<void>
  createBinary(path: string, content: ArrayBuffer): Promise<void>
  removeExactPath(path: string): Promise<void>
  removeEmptyFolder(path: string): Promise<void>
}

export type AnkiImportParserPort = {
  scanProject(projectPath: string): Promise<boolean>
  parseChapterCards(
    content: string,
    path: string,
  ): Readonly<{
    complete: boolean
    cards: readonly Readonly<{ cardUuid: string }>[]
  }>
}

export type AnkiImportSrsPort = {
  getProjectStateFilePath(projectSlug: string): Promise<string>
  initializeProjectStateAtPath(
    projectSlug: string,
    path: string,
    state: SrsProjectState,
    options: { activateCache: false },
  ): Promise<void>
  activateProjectState(projectSlug: string, state: SrsProjectState): void
  invalidateProject(projectSlug: string): void
  getProjectState(projectSlug: string): Promise<SrsProjectState>
  hasPersistedProjectStateAtPath(
    projectSlug: string,
    path: string,
  ): Promise<boolean>
  deletePersistedProjectStateAtPath(
    projectSlug: string,
    path: string,
  ): Promise<void>
}

export type AnkiImportJournalStorage = {
  create(content: string): Promise<string>
  write(path: string, content: string): Promise<void>
  list(): Promise<readonly string[]>
  read(path: string): Promise<string>
  remove(path: string): Promise<void>
}

export type AnkiJournalFilePort = {
  exists(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  write(path: string, content: string): Promise<void>
  list(path: string): Promise<Readonly<{ files: readonly string[] }>>
  read(path: string): Promise<string>
  remove(path: string): Promise<void>
}
