export type AnkiRating = 1 | 2 | 3 | 4

export type AnkiMediaReference = {
  kind: 'image' | 'audio'
  filename: string
  placeholder: string
}

export type AnkiRatingEvent = {
  cardId: number
  reviewedAt: number
  rating: AnkiRating
  intervalDays: number
}

export type AnkiCard = {
  id: number
  noteId: number
  deckId: number
  templateOrdinal: number
  front: string
  back: string
  media: AnkiMediaReference[]
  queue: number
  suspended: boolean
}

export type AnkiNote = {
  id: number
  modelId: number
  fields: string[]
  tags: string[]
  cards: AnkiCard[]
}

export type AnkiDeck = { id: number; name: string; path: string[] }

export type AnkiImportResult = {
  format: 'legacy' | 'modern'
  decks: AnkiDeck[]
  notes: AnkiNote[]
  media: Record<string, string>
  mediaFiles: Record<string, Uint8Array>
  srsPlan: { eventsByCard: Record<string, AnkiRatingEvent[]> }
  warnings: string[]
}

export type AnkiParseLimits = {
  packageBytes: number
  entryCount: number
  entryCompressedBytes: number
  entryUncompressedBytes: number
  totalUncompressedBytes: number
  collectionBytes: number
  mediaBytes: number
}

export const DEFAULT_ANKI_LIMITS: AnkiParseLimits = {
  packageBytes: 200 * 1024 * 1024,
  entryCount: 20_000,
  entryCompressedBytes: 200 * 1024 * 1024,
  entryUncompressedBytes: 512 * 1024 * 1024,
  totalUncompressedBytes: 1024 * 1024 * 1024,
  collectionBytes: 512 * 1024 * 1024,
  mediaBytes: 512 * 1024 * 1024,
}
