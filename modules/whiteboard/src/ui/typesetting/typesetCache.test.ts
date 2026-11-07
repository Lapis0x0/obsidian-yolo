import { GLYPH_WORDS } from '../gpu/instances'

import {
  decodePack,
  decodeTypeset,
  encodePacks,
  encodeTypeset,
  typesetStamp,
} from './typesetCache'
import type { TypesetCard, TypesetResultCard } from './typesetProtocol'

const card: TypesetCard = {
  id: 'n1',
  markdown: '# 标题\n\n正文',
  w: 400,
  h: 300,
  plain: false,
  color: null,
  images: { 'a.png': { w: 10, h: 20 } },
}

/** Glyph instances whose id words are `ids`, every other word its index. */
function glyphs(ids: readonly number[]): ArrayBuffer {
  const words = new Uint32Array(ids.length * GLYPH_WORDS)
  words.forEach((_, i) => (words[i] = i))
  ids.forEach((id, i) => (words[i * GLYPH_WORDS + 3] = id))
  return words.buffer
}

describe('typesetCache', () => {
  test('a card comes back as it was kept, its glyphs naming its own keys', () => {
    const typeset: TypesetResultCard = {
      id: 'n1',
      rects: new Uint32Array([1, 2, 3]).buffer,
      glyphs: glyphs([7, 2, 7]),
      greeks: new Uint32Array([9]).buffer,
      runs: new Float32Array([0, 2, 1.5, 0, 10, 20, 15, 4]).buffer,
      host: false,
      shown: '标题正文',
      images: [{ target: 'a.png', x: 1, y: 2, w: 10, h: 20, radius: 4 }],
    }
    const font = '400 15px "PingFang SC", ui-sans-serif, sans-serif'
    const key = (text: string) => `${font}${String.fromCharCode(0)}${text}`
    const batchKeys = ['k0', 'k1', key('二'), 'k3', 'k4', 'k5', 'k6', key('七')]
    const kept = decodeTypeset('n1', encodeTypeset(typeset, batchKeys))
    expect(kept).not.toBeNull()
    if (!kept) return
    expect(kept.keys).toEqual([key('七'), key('二')])
    const ids = new Uint32Array(kept.card.glyphs)
    expect([ids[3], ids[3 + GLYPH_WORDS], ids[3 + 2 * GLYPH_WORDS]]).toEqual([
      0, 1, 0,
    ])
    // Every other word as it was.
    expect(ids[0]).toBe(0)
    expect(ids[GLYPH_WORDS + 4]).toBe(GLYPH_WORDS + 4)
    expect([...new Uint32Array(kept.card.rects)]).toEqual([1, 2, 3])
    expect([...new Uint32Array(kept.card.greeks)]).toEqual([9])
    expect([...new Float32Array(kept.card.runs)]).toEqual([
      0, 2, 1.5, 0, 10, 20, 15, 4,
    ])
    expect(kept.card.shown).toBe('标题正文')
    expect(kept.card.images).toEqual(typeset.images)
    expect(kept.card.host).toBe(false)
    // What was kept is not changed by keeping it.
    expect(new Uint32Array(typeset.glyphs)[3]).toBe(7)
  })

  test('bytes that are not a kept card read as none', () => {
    expect(decodeTypeset('n1', new Uint8Array([1, 2, 3, 4, 5]).buffer)).toBe(
      null,
    )
  })

  test('a stamp changes with anything the card is typeset from', () => {
    const base = typesetStamp('look', card, { 'a.png': 'a.png' })
    expect(typesetStamp('look', card, { 'a.png': 'a.png' })).toBe(base)
    for (const other of [
      typesetStamp('other look', card, { 'a.png': 'a.png' }),
      typesetStamp(
        'look',
        { ...card, markdown: '# 标题' },
        { 'a.png': 'a.png' },
      ),
      typesetStamp('look', { ...card, w: 401 }, { 'a.png': 'a.png' }),
      typesetStamp('look', { ...card, h: 301 }, { 'a.png': 'a.png' }),
      typesetStamp('look', { ...card, color: '#f00' }, { 'a.png': 'a.png' }),
      typesetStamp(
        'look',
        { ...card, images: { 'a.png': { w: 11, h: 20 } } },
        { 'a.png': 'a.png' },
      ),
      typesetStamp('look', card, { 'a.png': 'img/a.png' }),
    ]) {
      expect(other).not.toBe(base)
    }
  })
})

describe('typeset packs', () => {
  test('a board comes back card by card as it was kept', () => {
    const cards = new Map([
      ['n1', { stamp: 'a', data: new Uint8Array([1, 2, 3, 4]).buffer }],
      ['n2', { stamp: 'b', data: new Uint8Array([5, 6, 7, 8, 9, 10]).buffer }],
      ['n3', { stamp: 'c', data: new ArrayBuffer(0) }],
    ])
    const [pack, ...rest] = encodePacks(cards)
    expect(rest).toEqual([])
    const back = decodePack(pack)
    expect([...back.keys()]).toEqual(['n1', 'n2', 'n3'])
    for (const [id, { stamp, data }] of cards) {
      expect(back.get(id)?.stamp).toBe(stamp)
      expect([
        ...new Uint8Array(back.get(id)?.data ?? new ArrayBuffer(1)),
      ]).toEqual([...new Uint8Array(data)])
    }
  })

  test('a board is kept in entries of at most 8 MB, a card whole in one', () => {
    const card = (bytes: number) => ({
      stamp: '',
      data: new ArrayBuffer(bytes),
    })
    const mb = 1024 * 1024
    const packs = encodePacks(
      new Map([
        ['a', card(5 * mb)],
        ['b', card(2 * mb)],
        ['c', card(2 * mb)],
        ['d', card(9 * mb)],
      ]),
    )
    expect(packs.map((p) => [...decodePack(p).keys()])).toEqual([
      ['a', 'b'],
      ['c'],
      ['d'],
    ])
  })

  test('bytes that are not a pack read as no cards', () => {
    expect(decodePack(new Uint8Array([9, 9, 9, 9, 9]).buffer).size).toBe(0)
  })
})
