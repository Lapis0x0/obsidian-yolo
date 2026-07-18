// eslint-disable-next-line import/no-nodejs-modules -- Tests load the installed WASM fixture from disk.
import { readFileSync } from 'node:fs'

// eslint-disable-next-line import/no-extraneous-dependencies -- The migrated parser test uses the workspace fixture dependency.
import * as JSZipModule from 'jszip'
// eslint-disable-next-line import/no-extraneous-dependencies -- The migrated parser test uses the workspace fixture dependency.
import initSqlJs, { type SqlJsStatic } from 'sql.js'

import { readAnkiArchive } from './archive'
import { htmlToMarkdown } from './htmlToMarkdown'
import { decodeModernMediaMap, decodePackageVersion } from './protobuf'
import { parseAnkiDatabase } from './sqlite'

const JSZip =
  (JSZipModule as unknown as { default?: typeof import('jszip') }).default ??
  JSZipModule
const wasm = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'))

const createCollection = async (): Promise<Uint8Array> => {
  const SQL = await initSqlJs({ wasmBinary: wasm })
  const db = new SQL.Database()
  db.run('CREATE TABLE col (decks text, models text)')
  db.run('CREATE TABLE notes (id integer, mid integer, tags text, flds text)')
  db.run(
    'CREATE TABLE cards (id integer, nid integer, did integer, ord integer, odid integer, queue integer)',
  )
  db.run(
    'CREATE TABLE revlog (id integer, cid integer, ease integer, ivl integer, type integer)',
  )
  const models = {
    10: {
      id: 10,
      name: 'Basic and reversed',
      type: 0,
      flds: [{ name: 'Front' }, { name: 'Back' }],
      tmpls: [
        { ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr>{{Back}}' },
        { ord: 1, qfmt: '{{Back}}', afmt: '{{Front}}' },
      ],
    },
    11: {
      id: 11,
      name: 'Cloze',
      type: 1,
      flds: [{ name: 'Text' }],
      tmpls: [{ ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}' }],
    },
    99: {
      id: 99,
      name: 'Unsupported',
      flds: [{ name: 'X' }],
      tmpls: [{ ord: 0, qfmt: '{{tts en_US:X}}', afmt: '{{X}}' }],
    },
  }
  const decks = {
    1: { id: 1, name: 'Languages' },
    2: { id: 2, name: 'Languages::Spanish' },
    3: { id: 3, name: 'Filtered' },
  }
  db.run('INSERT INTO col VALUES (?, ?)', [
    JSON.stringify(decks),
    JSON.stringify(models),
  ])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [
    100,
    10,
    ' vocab marked ',
    '<b>hola</b>\x1f<img src="pic.png">hello [sound:a.mp3]<script>x</script>',
  ])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [
    101,
    11,
    '',
    '{{c1::Madrid::city}} is in Spain',
  ])
  db.run('INSERT INTO notes VALUES (?, ?, ?, ?)', [102, 99, '', 'skip'])
  db.run(
    'INSERT INTO cards VALUES (1000, 100, 3, 0, 2, -1), (1001, 100, 2, 1, 0, 0), (1002, 101, 2, 0, 0, -2), (1003, 102, 2, 0, 0, 0)',
  )
  db.run(
    'INSERT INTO revlog VALUES (10000, 1000, 3, 10, 1), (10001, 1000, 4, 20, 4), (10002, 9999, 2, 1, 1), (9999999999999, 1000, 2, 1, 1)',
  )
  const bytes = db.export()
  db.close()
  return bytes
}

describe('Anki parser kernel', () => {
  test('reads a generated legacy APKG and normalizes cards, media and revlog', async () => {
    const collection = await createCollection()
    const zip = new JSZip()
    zip.file('collection.anki21', collection)
    zip.file('media', JSON.stringify({ 0: 'pic.png', 1: 'a.mp3' }))
    zip.file('0', new Uint8Array([1, 2]))
    zip.file('1', new Uint8Array([3]))
    const packageBytes = await zip.generateAsync({ type: 'uint8array' })
    const archive = await readAnkiArchive(packageBytes)
    const SQL = await initSqlJs({ wasmBinary: wasm })
    const result = parseAnkiDatabase(
      SQL,
      archive.collection,
      archive.format,
      archive.media,
      20_000,
      archive.mediaFiles,
    )

    expect(result.decks.map((deck) => deck.name)).toEqual([
      'Languages::Spanish',
    ])
    expect(result.notes).toHaveLength(2)
    expect(result.notes[0].cards[0]).toMatchObject({
      deckId: 2,
      front: '**hola**',
      suspended: true,
    })
    expect(result.notes[0].cards[0].back).not.toContain('script')
    expect(result.notes[0].cards[0].media.map((item) => item.filename)).toEqual(
      ['pic.png', 'a.mp3'],
    )
    expect(result.notes[1].cards[0].front).toContain('[city]')
    expect(result.srsPlan.eventsByCard['1000']).toHaveLength(1)
    expect([...result.mediaFiles['pic.png']]).toEqual([1, 2])
    expect([...result.mediaFiles['a.mp3']]).toEqual([3])
    expect(result.warnings).toContain(
      'Skipped note 102: unsupported or unknown model',
    )
  })

  test('retains archive traversal and capacity guards', async () => {
    const duplicateCollections = new JSZip()
      .file('collection.anki2', new Uint8Array([1]))
      .file('collection.anki21', new Uint8Array([1]))
    await expect(
      readAnkiArchive(
        await duplicateCollections.generateAsync({ type: 'uint8array' }),
      ),
    ).rejects.toThrow('exactly one')

    const unsafePath = new JSZip()
      .file('collection.anki2', new Uint8Array([1]))
      .file('unsafe\\name', new Uint8Array([1]))
    await expect(
      readAnkiArchive(await unsafePath.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow('Unsafe APKG entry path')

    const packageBytes = await new JSZip()
      .file('collection.anki2', new Uint8Array([1]))
      .generateAsync({ type: 'uint8array' })
    await expect(
      readAnkiArchive(packageBytes, {
        packageBytes: packageBytes.byteLength - 1,
      }),
    ).rejects.toThrow('package size limit')
    await expect(
      readAnkiArchive(packageBytes, { entryCount: 0 }),
    ).rejects.toThrow('too many entries')
  })

  test('rejects unsafe media names and expanded media over the limit', async () => {
    const unsafe = new JSZip()
      .file('collection.anki2', new Uint8Array([1]))
      .file('media', JSON.stringify({ 0: '../pic.png' }))
      .file('0', new Uint8Array([1]))
    await expect(
      readAnkiArchive(await unsafe.generateAsync({ type: 'uint8array' })),
    ).rejects.toThrow('Unsafe media filename')

    const oversized = new JSZip()
      .file('collection.anki2', new Uint8Array([1]))
      .file('media', JSON.stringify({ 0: 'pic.png' }))
      .file('0', new Uint8Array([1, 2]))
    await expect(
      readAnkiArchive(await oversized.generateAsync({ type: 'uint8array' }), {
        mediaBytes: 1,
      }),
    ).rejects.toThrow(/Media (manifest|files).*size limit/)
  })

  test('decodes modern metadata and media protobuf', () => {
    expect(decodePackageVersion(new Uint8Array([8, 2]))).toBe(2)
    expect(
      decodeModernMediaMap(
        new Uint8Array([10, 9, 10, 7, 112, 105, 99, 46, 112, 110, 103]),
      ),
    ).toEqual({ 0: 'pic.png' })
  })

  test('decompresses each modern media entry', async () => {
    const zip = new JSZip()
    zip.file(
      'collection.anki21b',
      new Uint8Array([
        0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58, 0x11, 0, 0, 0x64, 0x62, 0x2a, 0xec,
        0x4f, 0xda,
      ]),
    )
    zip.file(
      'media',
      new Uint8Array([10, 9, 10, 7, 112, 105, 99, 46, 112, 110, 103]),
    )
    zip.file(
      '0',
      new Uint8Array([
        0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58, 0x59, 0, 0, 0x6d, 0x65, 0x64, 0x69,
        0x61, 0x2d, 0x62, 0x79, 0x74, 0x65, 0x73, 0xee, 0xda, 0xbd, 0x69,
      ]),
    )
    const archive = await readAnkiArchive(
      await zip.generateAsync({ type: 'uint8array' }),
    )
    expect(new TextDecoder().decode(archive.collection)).toBe('db')
    expect(new TextDecoder().decode(archive.mediaFiles.get('pic.png'))).toBe(
      'media-bytes',
    )
  })

  test('reads schema v18 normalized JSON columns', async () => {
    const SQL = await initSqlJs({ wasmBinary: wasm })
    const db = new SQL.Database()
    db.run('CREATE TABLE notetypes (id integer, name text, config text)')
    db.run(
      'CREATE TABLE fields (ntid integer, ord integer, name text, config text)',
    )
    db.run(
      'CREATE TABLE templates (ntid integer, ord integer, name text, config text)',
    )
    db.run('CREATE TABLE decks (id integer, name text)')
    db.run('CREATE TABLE notes (id integer, mid integer, tags text, flds text)')
    db.run(
      'CREATE TABLE cards (id integer, nid integer, did integer, ord integer, odid integer)',
    )
    db.run(
      'CREATE TABLE revlog (id integer, cid integer, ease integer, ivl integer, type integer)',
    )
    db.run('INSERT INTO notetypes VALUES (10, ?, ?)', [
      'Basic',
      JSON.stringify({ type: 0 }),
    ])
    db.run(
      "INSERT INTO fields VALUES (10, 0, 'Front', '{}'), (10, 1, 'Back', '{}')",
    )
    db.run('INSERT INTO templates VALUES (10, 0, ?, ?)', [
      'Card 1',
      JSON.stringify({ qfmt: '{{Front}}', afmt: '{{Back}}' }),
    ])
    db.run("INSERT INTO decks VALUES (1, 'Root::Child')")
    db.run("INSERT INTO notes VALUES (1, 10, '', 'Q\x1fA')")
    db.run('INSERT INTO cards VALUES (2, 1, 1, 0, 0)')
    const result = parseAnkiDatabase(SQL, db.export(), 'modern', {})
    expect(result.notes[0].cards[0]).toMatchObject({ front: 'Q', back: 'A' })
    db.close()
  })

  test('always closes the database when parsing fails', () => {
    const close = jest.fn()
    const db = {
      exec: jest.fn(() => [{ columns: ['name'], values: [['notes']] }]),
      close,
    }
    const SQL = {
      Database: jest.fn(() => db),
    } as unknown as SqlJsStatic

    expect(() =>
      parseAnkiDatabase(SQL, new Uint8Array(), 'legacy', {}),
    ).toThrow('missing cards')
    expect(close).toHaveBeenCalledTimes(1)
  })

  test('sanitizes dangerous HTML and converts safe structured HTML', () => {
    expect(
      htmlToMarkdown(
        '<iframe>x</iframe><img src="javascript:x"><b>safe</b>[sound:../x]',
      ),
    ).toEqual({ markdown: '**safe**', media: [] })

    const result = htmlToMarkdown(
      '<p>A<br><strong>B</strong> <a href="https://example.com/a">link</a></p><blockquote>Q</blockquote><ul><li>One</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><a href="data:text/html,x">bad</a>',
    )
    expect(result.markdown).toContain('A\n**B** [link](https://example.com/a)')
    expect(result.markdown).toContain('> Q')
    expect(result.markdown).toContain('- One')
    expect(result.markdown).toContain('| A | B |')
    expect(result.markdown).not.toContain('data:')
  })
})
