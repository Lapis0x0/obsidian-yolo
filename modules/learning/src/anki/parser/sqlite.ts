/* eslint-disable import/no-extraneous-dependencies -- Parser dependencies are supplied by the first-party module build workspace. */
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js'

import { htmlToMarkdown } from './htmlToMarkdown'
import { type AnkiModel, renderCardTemplate } from './templates'
import type {
  AnkiDeck,
  AnkiImportResult,
  AnkiNote,
  AnkiRatingEvent,
} from './types'

type Value = number | string | Uint8Array | null
type Row = Record<string, Value>

const stringValue = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : ''

const rows = (db: Database, sql: string): Row[] => {
  const result = db.exec(sql)[0]
  if (!result) return []
  return result.values.map((values) =>
    Object.fromEntries(
      result.columns.map((column, index) => [column, values[index]]),
    ),
  )
}

const tables = (db: Database): Set<string> =>
  new Set(
    rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map((row) =>
      String(row.name),
    ),
  )

const columns = (db: Database, table: string): Set<string> =>
  new Set(
    rows(db, `PRAGMA table_info(${table})`).map((row) => String(row.name)),
  )

const parseJsonRecord = (value: Value): Record<string, unknown> => {
  if (typeof value !== 'string' || !value.trim()) return {}
  const parsed: unknown = JSON.parse(value)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

const parseModels = (
  db: Database,
  available: Set<string>,
): Map<number, AnkiModel> => {
  let rawModels: Record<string, unknown> = {}
  if (available.has('col') && columns(db, 'col').has('models'))
    rawModels = parseJsonRecord(
      rows(db, 'SELECT models FROM col LIMIT 1')[0]?.models ?? null,
    )
  if (!Object.keys(rawModels).length && available.has('notetypes')) {
    for (const row of rows(db, 'SELECT * FROM notetypes')) {
      const object = parseJsonRecord(row.json ?? row.config ?? null)
      rawModels[String(row.id)] = {
        ...object,
        id: row.id,
        name: row.name ?? object.name,
      }
    }
    if (available.has('fields') && available.has('templates')) {
      for (const [id, raw] of Object.entries(rawModels)) {
        const model = raw as Record<string, unknown>
        model.fields = rows(
          db,
          `SELECT * FROM fields WHERE ntid = ${Number(id)} ORDER BY ord`,
        ).map((row) => ({ name: row.name }))
        model.templates = rows(
          db,
          `SELECT * FROM templates WHERE ntid = ${Number(id)} ORDER BY ord`,
        ).map((row) => {
          const config = parseJsonRecord(row.json ?? row.config ?? null)
          return { ...config, name: row.name, ord: row.ord }
        })
      }
    }
  }
  const models = new Map<number, AnkiModel>()
  for (const [key, value] of Object.entries(rawModels)) {
    if (!value || typeof value !== 'object') continue
    const model = value as Record<string, unknown>
    const fieldObjects = Array.isArray(model.flds)
      ? model.flds
      : Array.isArray(model.fields)
        ? model.fields
        : []
    const templateObjects = Array.isArray(model.tmpls)
      ? model.tmpls
      : Array.isArray(model.templates)
        ? model.templates
        : []
    const fields = fieldObjects.map((field) =>
      stringValue((field as Record<string, unknown>).name),
    )
    const templates = templateObjects.map((template, index) => {
      const item = template as Record<string, unknown>
      return {
        name: stringValue(item.name),
        ord: Number(item.ord ?? index),
        qfmt: stringValue(item.qfmt ?? item.questionFormat),
        afmt: stringValue(item.afmt ?? item.answerFormat),
      }
    })
    const id = Number(model.id ?? key)
    const cloze = Number(model.type ?? 0) === 1
    const supported =
      cloze ||
      templates.every(
        (template) =>
          !/{{[^{}]*(?:type:|tts\b|furigana:|kanji:|kana:)/i.test(
            `${template.qfmt}${template.afmt}`,
          ),
      )
    if (Number.isFinite(id) && fields.length && templates.length && supported)
      models.set(id, {
        id,
        name: stringValue(model.name),
        fields,
        templates,
        cloze,
      })
  }
  return models
}

const parseDecks = (
  db: Database,
  available: Set<string>,
): Map<number, AnkiDeck> => {
  const decks = new Map<number, AnkiDeck>()
  let raw: Record<string, unknown> = {}
  if (available.has('col') && columns(db, 'col').has('decks'))
    raw = parseJsonRecord(
      rows(db, 'SELECT decks FROM col LIMIT 1')[0]?.decks ?? null,
    )
  for (const [key, value] of Object.entries(raw)) {
    const item = value as Record<string, unknown>
    const id = Number(item.id ?? key)
    const name = stringValue(item.name)
    if (Number.isFinite(id) && name)
      decks.set(id, { id, name, path: name.split('::') })
  }
  if (!decks.size && available.has('decks')) {
    for (const row of rows(db, 'SELECT * FROM decks')) {
      const id = Number(row.id)
      const name = String(row.name ?? '')
      if (Number.isFinite(id) && name)
        decks.set(id, { id, name, path: name.split('::') })
    }
  }
  return decks
}

export const parseAnkiDatabase = (
  SQL: SqlJsStatic,
  bytes: Uint8Array,
  format: 'legacy' | 'modern',
  media: Record<string, string>,
  now = Date.now(),
  mediaFiles: ReadonlyMap<string, Uint8Array> = new Map(),
): AnkiImportResult => {
  const db = new SQL.Database(bytes)
  try {
    const available = tables(db)
    for (const required of ['notes', 'cards', 'revlog'])
      if (!available.has(required))
        throw new Error(`Anki database is missing ${required}`)
    const models = parseModels(db, available)
    const decks = parseDecks(db, available)
    const noteRows = rows(db, 'SELECT id, mid, tags, flds FROM notes')
    const cardColumns = columns(db, 'cards')
    const cardRows = rows(
      db,
      `SELECT id, nid, did, ord, odid, ${cardColumns.has('queue') ? 'queue' : '0 AS queue'} FROM cards`,
    )
    const cardsByNote = new Map<number, Row[]>()
    for (const card of cardRows) {
      const list = cardsByNote.get(Number(card.nid)) ?? []
      list.push(card)
      cardsByNote.set(Number(card.nid), list)
    }
    const notes: AnkiNote[] = []
    const validCardIds = new Set<number>()
    const warnings: string[] = []
    for (const noteRow of noteRows) {
      const model = models.get(Number(noteRow.mid))
      if (!model) {
        warnings.push(
          `Skipped note ${noteRow.id}: unsupported or unknown model`,
        )
        continue
      }
      const fields = String(noteRow.flds ?? '').split('\x1f')
      const noteCards = []
      for (const cardRow of cardsByNote.get(Number(noteRow.id)) ?? []) {
        const rendered = renderCardTemplate(model, fields, Number(cardRow.ord))
        if (!rendered) continue
        const front = htmlToMarkdown(rendered.front)
        const back = htmlToMarkdown(rendered.back)
        const id = Number(cardRow.id)
        const originalDeckId = Number(cardRow.odid)
        const deckId = originalDeckId > 0 ? originalDeckId : Number(cardRow.did)
        noteCards.push({
          id,
          noteId: Number(noteRow.id),
          deckId,
          templateOrdinal: Number(cardRow.ord),
          front: front.markdown,
          back: back.markdown,
          media: [...front.media, ...back.media],
          queue: Number(cardRow.queue),
          suspended: Number(cardRow.queue) === -1,
        })
        validCardIds.add(id)
      }
      if (noteCards.length)
        notes.push({
          id: Number(noteRow.id),
          modelId: model.id,
          fields,
          tags: String(noteRow.tags ?? '')
            .trim()
            .split(/\s+/)
            .filter(Boolean),
          cards: noteCards,
        })
    }
    const usedDeckIds = new Set(
      notes.flatMap((note) => note.cards.map((card) => card.deckId)),
    )
    const usedDecks = [...usedDeckIds]
      .map((id) => decks.get(id))
      .filter((deck): deck is AnkiDeck => !!deck)
    const roots = new Set(usedDecks.map((deck) => deck.path[0]))
    if (roots.size > 1)
      throw new Error('APKG contains more than one top-level deck')
    const eventsByCard: Record<string, AnkiRatingEvent[]> = {}
    for (const row of rows(
      db,
      'SELECT id, cid, ease, ivl, type FROM revlog ORDER BY cid, id',
    )) {
      const cardId = Number(row.cid)
      const reviewedAt = Number(row.id)
      const rating = Number(row.ease)
      if (
        !validCardIds.has(cardId) ||
        rating < 1 ||
        rating > 4 ||
        Number(row.type) === 4 ||
        reviewedAt > now + 5 * 60_000
      )
        continue
      const event: AnkiRatingEvent = {
        cardId,
        reviewedAt,
        rating: rating as 1 | 2 | 3 | 4,
        intervalDays: Math.max(
          0,
          Number(row.ivl) < 0 ? -Number(row.ivl) / 86400 : Number(row.ivl),
        ),
      }
      const list = eventsByCard[String(cardId)] ?? []
      if (list[list.length - 1]?.reviewedAt === reviewedAt)
        list[list.length - 1] = event
      else list.push(event)
      eventsByCard[String(cardId)] = list
    }
    const referencedMedia = new Set(
      notes.flatMap((note) =>
        note.cards.flatMap((card) => card.media.map((item) => item.filename)),
      ),
    )
    return {
      format,
      decks: usedDecks.sort((a, b) => a.name.localeCompare(b.name)),
      notes,
      media: Object.fromEntries(
        Object.entries(media).filter(([, filename]) =>
          referencedMedia.has(filename),
        ),
      ),
      mediaFiles: Object.fromEntries(
        [...referencedMedia]
          .map((filename) => [filename, mediaFiles.get(filename)] as const)
          .filter((pair): pair is readonly [string, Uint8Array] => !!pair[1]),
      ),
      srsPlan: { eventsByCard },
      warnings,
    }
  } finally {
    db.close()
  }
}

export const initAnkiSqlite = (wasmBinary: Uint8Array): Promise<SqlJsStatic> =>
  initSqlJs({ wasmBinary })
