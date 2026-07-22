import type { SrsProjectState } from '../../domain/srs/srsTypes'
import { createUniqueSlug } from '../../generation/slug'

import type {
  AnkiSrsReplayPort,
  ParsedAnkiCard,
  ParsedAnkiImport,
} from './ports'

export type AnkiImportAsset = Readonly<{
  sourceName: string
  fileName: string
  bytes: Uint8Array
}>

export type AnkiImportCard = Readonly<{
  ankiCardId: number
  uuid: string
  title: string
  front: string
  back: string
}>

export type AnkiImportChapter = Readonly<{
  title: string
  slug: string
  cards: readonly AnkiImportCard[]
}>

export type AnkiImportPlan = Readonly<{
  version: 1
  projectName: string
  projectSlug: string
  baseDir: string
  projectPath: string
  chapters: readonly AnkiImportChapter[]
  assets: readonly AnkiImportAsset[]
  srsState: SrsProjectState
  cardCount: number
  warnings: readonly string[]
}>

const safeExtension = (name: string): string => {
  const match = /\.([a-z\d]{1,10})$/i.exec(name)
  return match ? `.${match[1].toLowerCase()}` : ''
}

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
}

const plainTitle = (markdown: string): string => {
  const plain = markdown
    .replace(/{{anki-media:[^}]+}}/g, '')
    .replace(/!?(?:\[([^\]]*)])(?:\([^)]*\))?/g, '$1')
    .replace(/[*_~`>#|]/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) return 'Untitled card'
  return plain.length > 80 ? `${plain.slice(0, 77).trimEnd()}...` : plain
}

const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

export async function buildAnkiImportPlan({
  parsed,
  baseDir,
  existingProjectSlugs,
  srsReplay,
}: {
  parsed: ParsedAnkiImport
  baseDir: string
  existingProjectSlugs: Iterable<string>
  srsReplay: AnkiSrsReplayPort
}): Promise<AnkiImportPlan> {
  const root = parsed.decks[0]?.path[0]?.trim()
  if (!root) throw new Error('APKG does not contain an importable deck')
  const projectSlug = createUniqueSlug(root, existingProjectSlugs)
  const normalizedBaseDir = baseDir.replace(/\/$/, '')
  const projectPath = `${normalizedBaseDir}/${projectSlug}`
  const cards = parsed.notes.flatMap((note) => note.cards)
  const usedUuids = new Set<string>()
  const uuidByCard = new Map<number, string>()
  for (const card of cards) {
    let uuid = ''
    do uuid = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
    while (usedUuids.has(uuid))
    usedUuids.add(uuid)
    uuidByCard.set(card.id, uuid)
  }

  const assetBySource = new Map<string, AnkiImportAsset>()
  for (const [sourceName, bytes] of Object.entries(parsed.mediaFiles)) {
    const digest = await sha256(bytes)
    assetBySource.set(sourceName, {
      sourceName,
      fileName: `${digest}${safeExtension(sourceName)}`,
      bytes,
    })
  }

  const deckById = new Map(parsed.decks.map((deck) => [deck.id, deck]))
  const chapterCards = new Map<string, ParsedAnkiCard[]>()
  for (const card of cards) {
    const path = deckById.get(card.deckId)?.path ?? [root]
    const title = path.length === 1 ? root : path.slice(1).join(' / ')
    chapterCards.set(title, [...(chapterCards.get(title) ?? []), card])
  }
  const chapterSlugs: string[] = []
  const chapters = [...chapterCards].map(([title, sourceCards]) => {
    const slug = createUniqueSlug(title, chapterSlugs)
    chapterSlugs.push(slug)
    return {
      title,
      slug,
      cards: sourceCards.map((card) => ({
        ankiCardId: card.id,
        uuid: uuidByCard.get(card.id)!,
        title: plainTitle(card.front),
        front: card.front,
        back: card.back,
      })),
    }
  })

  const stateCards: SrsProjectState['cards'] = {}
  const suspended: string[] = []
  for (const card of cards) {
    const uuid = uuidByCard.get(card.id)!
    const events = parsed.srsPlan.eventsByCard[String(card.id)] ?? []
    if (events.length) {
      stateCards[uuid] = srsReplay.replay(
        events,
        new Date(events[0].reviewedAt),
      )
    }
    if (card.suspended) suspended.push(uuid)
  }
  return freeze({
    version: 1,
    projectName: root,
    projectSlug,
    baseDir: normalizedBaseDir,
    projectPath,
    chapters,
    assets: [...assetBySource.values()],
    srsState: {
      version: 3,
      cards: stateCards,
      suspended: suspended.sort(),
      pausedAt: null,
      lastStudiedAt: Object.values(stateCards).reduce<string | null>(
        (latest, card) =>
          card.lastReview && (!latest || card.lastReview > latest)
            ? card.lastReview
            : latest,
        null,
      ),
    },
    cardCount: cards.length,
    warnings: parsed.warnings,
  })
}

export function renameAnkiImportPlan({
  plan,
  projectName,
  existingProjectSlugs,
}: {
  plan: AnkiImportPlan
  projectName: string
  existingProjectSlugs: Iterable<string>
}): AnkiImportPlan {
  const name = projectName.trim()
  if (!name) throw new Error('Project name is required')
  const projectSlug = createUniqueSlug(name, existingProjectSlugs)
  return freeze({
    ...plan,
    projectName: name,
    projectSlug,
    projectPath: `${plan.baseDir}/${projectSlug}`,
    chapters: plan.chapters.map((chapter) =>
      chapter.title === plan.projectName
        ? { ...chapter, title: name }
        : chapter,
    ),
  })
}
