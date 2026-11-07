// Typeset cards kept on this device (../../host/pictureStore.ts — a board is
// a group, a card an entry), so that a board opened again places what it was
// typeset as instead of typesetting every card anew.
//
// What the typesetter makes of a card is a function of what it is given and
// nothing else: the card (./typesetProtocol.ts's `TypesetCard` — the text it
// shows, its size, its colour, the sizes of its images), the files its images
// resolve to, the look it is typeset in, and the typesetter's own code. A
// card's stamp is all of them together, so a kept card whose stamp is not the
// one asked for is never used: it is typeset again, and kept in its place.

import { hashText } from '../../domain/hash'
import { GLYPH_WORDS } from '../gpu/instances'

import {
  TYPESET_WORKER,
  type TypesetCard,
  type TypesetResultCard,
} from './typesetProtocol'

/** The group version a board's cards are kept under: raised when the shape
 * they are kept in changes, and a group of another is let go of whole. */
export const TYPESET_GROUP_VERSION = 2

/** The typesetting worker's code, as built: whatever it changes, a card
 * kept by another is not used. The build names each worker's source by its
 * hash (scripts/build-first-party-modules.mjs); a test has none. */
const WORKER_HASH: string =
  (
    JSON.parse(process.env.YOLO_WORKER_HASHES ?? '{}') as Record<string, string>
  )[TYPESET_WORKER] ?? ''

/** What a card typeset in `look` from these inputs is kept under. */
export function typesetStamp(
  look: string,
  card: TypesetCard,
  paths: Readonly<Record<string, string>>,
): string {
  return hashText(
    JSON.stringify([
      card.markdown,
      card.w,
      card.h,
      card.plain,
      card.color,
      card.images ?? {},
      paths,
    ]),
    `${WORKER_HASH}|${look}`,
  )
}

/** What a key's head and the rest are joined by (./typesetProtocol.ts's
 * `glyphKey`, `iconKey`). */
const SEPARATOR = String.fromCharCode(0)

/** A typeset card as kept: its glyphs name keys of its own (`keys`), not
 * the batch's it came in. */
export type KeptCard = Readonly<{
  card: TypesetResultCard
  keys: readonly string[]
}>

type Header = Readonly<{
  host: boolean
  shown: string
  images: TypesetResultCard['images']
  /** What its keys start with before their first separator — a glyph's
   * font, an icon's name — each once: a font is a long list of families,
   * and a card's glyphs share a few. */
  heads: readonly string[]
  /** Its keys, each as a head's index and what follows the separator. */
  keys: readonly (readonly [number, string])[]
  /** Byte lengths of rects, glyphs, greeks and runs, in that order. */
  lengths: readonly [number, number, number, number]
}>

/** A card as the worker typeset it, its glyphs' keys among `batchKeys`, as
 * the bytes it is kept in. */
export function encodeTypeset(
  card: TypesetResultCard,
  batchKeys: readonly string[],
): ArrayBuffer {
  // Its own keys, in the order its glyphs first use them.
  const glyphs = new Uint32Array(card.glyphs.slice(0))
  const local = new Map<number, number>()
  const keys: string[] = []
  for (let i = 3; i < glyphs.length; i += GLYPH_WORDS) {
    let index = local.get(glyphs[i])
    if (index === undefined) {
      index = keys.length
      local.set(glyphs[i], index)
      keys.push(batchKeys[glyphs[i]])
    }
    glyphs[i] = index
  }
  const buffers = [card.rects, glyphs.buffer, card.greeks, card.runs]
  const heads: string[] = []
  const headIndex = new Map<string, number>()
  const split = keys.map((key) => {
    const at = key.indexOf(SEPARATOR)
    const head = key.slice(0, at)
    let index = headIndex.get(head)
    if (index === undefined) {
      index = heads.length
      headIndex.set(head, index)
      heads.push(head)
    }
    return [index, key.slice(at + 1)] as const
  })
  const header: Header = {
    host: card.host,
    shown: card.shown,
    images: card.images,
    heads,
    keys: split,
    lengths: [
      buffers[0].byteLength,
      buffers[1].byteLength,
      buffers[2].byteLength,
      buffers[3].byteLength,
    ],
  }
  const text = new TextEncoder().encode(JSON.stringify(header))
  // The buffers after it start on a word, as their arrays read them.
  const start = align(4 + text.byteLength)
  const out = new Uint8Array(
    start + header.lengths.reduce((sum, n) => sum + n, 0),
  )
  new DataView(out.buffer).setUint32(0, text.byteLength, true)
  out.set(text, 4)
  let at = start
  for (const buffer of buffers) {
    out.set(new Uint8Array(buffer), at)
    at += buffer.byteLength
  }
  return out.buffer
}

/** A kept card back, as card `id`; null for bytes not written by
 * `encodeTypeset`. */
export function decodeTypeset(id: string, data: ArrayBuffer): KeptCard | null {
  try {
    const length = new DataView(data).getUint32(0, true)
    const header = JSON.parse(
      new TextDecoder().decode(new Uint8Array(data, 4, length)),
    ) as Header
    let at = align(4 + length)
    const [rects, glyphs, greeks, runs] = header.lengths.map((n) => {
      const buffer = data.slice(at, at + n)
      at += n
      return buffer
    })
    if (at !== data.byteLength) return null
    return {
      card: {
        id,
        rects,
        glyphs,
        greeks,
        runs,
        host: header.host,
        shown: header.shown,
        images: header.images,
      },
      keys: header.keys.map(
        ([head, rest]) => `${header.heads[head]}${SEPARATOR}${rest}`,
      ),
    }
  } catch {
    return null
  }
}

function align(n: number): number {
  return Math.ceil(n / 4) * 4
}

/** The entries a board's cards are kept in, in order: read a few at a time
 * when the board opens, rather than a card at a time, and each well within
 * what the host keeps in one (16 MB). */
export const packKey = (index: number): string => `cards-${index}`
const PACK_BYTES = 8 * 1024 * 1024

/** A kept card: what it was typeset from (`typesetStamp`), and its bytes
 * (`encodeTypeset`). */
export type KeptBytes = Readonly<{ stamp: string; data: ArrayBuffer }>

/** A board's kept cards, by id, as the bytes of its entries (`packKey`). */
export function encodePacks(
  cards: ReadonlyMap<string, KeptBytes>,
): ArrayBuffer[] {
  const packs: ArrayBuffer[] = []
  let pack = new Map<string, KeptBytes>()
  let bytes = 0
  for (const [id, card] of cards) {
    if (pack.size > 0 && bytes + card.data.byteLength > PACK_BYTES) {
      packs.push(encodePack(pack))
      pack = new Map()
      bytes = 0
    }
    pack.set(id, card)
    bytes += card.data.byteLength
  }
  if (pack.size > 0) packs.push(encodePack(pack))
  return packs
}

/** Cards as one entry's bytes: their ids, stamps and lengths, then each
 * card's bytes on a word. */
function encodePack(cards: ReadonlyMap<string, KeptBytes>): ArrayBuffer {
  const list = [...cards].map(
    ([id, { stamp, data }]) => [id, stamp, data.byteLength] as const,
  )
  const text = new TextEncoder().encode(JSON.stringify(list))
  const start = align(4 + text.byteLength)
  const out = new Uint8Array(
    start + list.reduce((sum, [, , length]) => sum + align(length), 0),
  )
  new DataView(out.buffer).setUint32(0, text.byteLength, true)
  out.set(text, 4)
  let at = start
  for (const { data } of cards.values()) {
    out.set(new Uint8Array(data), at)
    at += align(data.byteLength)
  }
  return out.buffer
}

/** An entry's cards back; none for bytes not written by `encodePack`. */
export function decodePack(data: ArrayBuffer): Map<string, KeptBytes> {
  const cards = new Map<string, KeptBytes>()
  try {
    const length = new DataView(data).getUint32(0, true)
    const list = JSON.parse(
      new TextDecoder().decode(new Uint8Array(data, 4, length)),
    ) as [string, string, number][]
    let at = align(4 + length)
    for (const [id, stamp, size] of list) {
      if (at + size > data.byteLength) return new Map()
      cards.set(id, { stamp, data: data.slice(at, at + size) })
      at += align(size)
    }
  } catch {
    return new Map()
  }
  return cards
}
