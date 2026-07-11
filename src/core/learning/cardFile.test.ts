import { TFile } from 'obsidian'
import type { App } from 'obsidian'

import {
  CardFileConflictError,
  LearningCardFileStore,
  parseCardFile,
  scanProjectCards,
} from './cardFile'

const A =
  '## A <!--card:aaaaaaaa kp:11111111-->\n\n**正面：** front A\n\n**背面：** back A'
const B =
  '## B <!--card:bbbbbbbb kp:22222222-->\n\n**正面：** front B\n\n**背面：** back B'

function createApp(initialFiles: Record<string, string>) {
  const files = new Map(Object.entries(initialFiles))
  const fileObjects = new Map(
    [...files.keys()].map((path) => {
      const file = new TFile()
      file.path = path
      file.name = path.split('/').at(-1) ?? ''
      return [path, file]
    }),
  )
  const adapter = {
    write: jest.fn(),
  }
  const read = jest.fn(async (file: TFile) => {
    const content = files.get(file.path)
    if (content === undefined) throw new Error(`missing: ${file.path}`)
    return content
  })
  const modify = jest.fn(async (file: TFile, content: string) => {
    files.set(file.path, content)
  })
  const create = jest.fn(async (path: string, content: string) => {
    const file = new TFile()
    file.path = path
    file.name = path.split('/').at(-1) ?? ''
    fileObjects.set(path, file)
    files.set(path, content)
    return file
  })
  const deleteFile = jest.fn(async (file: TFile) => {
    fileObjects.delete(file.path)
    files.delete(file.path)
  })
  const cachedRead = jest.fn(async (file: TFile) => read(file))
  const app = {
    vault: {
      adapter,
      getMarkdownFiles: () => [...fileObjects.values()],
      getAbstractFileByPath: (path: string) => fileObjects.get(path) ?? null,
      cachedRead,
      read,
      modify,
      create,
      delete: deleteFile,
    },
  } as unknown as App
  return {
    app,
    adapter,
    files,
    fileObjects,
    cachedRead,
    read,
    modify,
    create,
    deleteFile,
  }
}

describe('cardFile', () => {
  it('strictly parses cards with exact source positions', () => {
    const content = `---\ntitle: Cards\n---\n\nintro\n\n${A}\n`
    const result = parseCardFile(content, 'p/c/cards.md')

    expect(result.complete).toBe(true)
    expect(result.cards[0]).toMatchObject({
      cardUuid: 'aaaaaaaa',
      kpUuid: '11111111',
      title: 'A',
      front: 'front A',
      back: 'back A',
      rawBlock: A,
      startLine: 7,
      startOffset: content.indexOf(A),
      endOffset: content.indexOf(A) + A.length,
    })
  })

  it('parses multiline Markdown on the card front', () => {
    const front =
      'first line\n\n- item one\n- item two\n\n```ts\nconst n = 1\n```'
    const content = `## Multi <!--card:aaaaaaaa kp:11111111-->\n\n**正面：** ${front}\n\n**背面：** answer`

    const result = parseCardFile(content)

    expect(result.complete).toBe(true)
    expect(result.cards[0].front).toBe(front)
    expect(result.cards[0].back).toBe('answer')
  })

  it('rejects a level-two heading directly in the card back', () => {
    const result = parseCardFile(`${A}\n\n## unexpected\n\nmore text`)

    expect(result.complete).toBe(false)
    expect(result.errors).toEqual([
      expect.objectContaining({
        line: 7,
        message: 'cards.md 中的二级标题必须是合法卡片标题',
      }),
    ])
  })

  it('keeps level-two heading text inside matching code fences', () => {
    const back =
      'before\n\n```md\n## backtick heading\n```\n\n~~~~text\n## tilde heading\n~~~\nstill fenced\n~~~~'
    const content = `## Fenced <!--card:aaaaaaaa kp:11111111-->\n\n**正面：** front\n\n**背面：** ${back}`
    const result = parseCardFile(content)

    expect(result.complete).toBe(true)
    expect(result.cards[0].back).toBe(back)
    expect(result.cards[0].rawBlock).toBe(content)
  })

  it('reports malformed cards and duplicate UUIDs', () => {
    const malformed = '## Bad <!-- card:aaaaaaaa kp:11111111 -->\n\nno fields'
    const invalidBody =
      '## Broken <!--card:aaaaaaaa kp:11111111-->\n\nno fields'
    const result = parseCardFile(`${A}\n\n${invalidBody}\n\n${malformed}`)

    expect(result.complete).toBe(false)
    expect(result.duplicateUuids).toEqual(new Set(['aaaaaaaa']))
    expect(result.errors.map((error) => error.message)).toEqual(
      expect.arrayContaining([
        'card UUID 重复：aaaaaaaa',
        'cards.md 中的二级标题必须是合法卡片标题',
      ]),
    )
  })

  it('scans project UUIDs and detects duplicates across files', async () => {
    const { app } = createApp({
      'p/a/cards.md': `${A}\n`,
      'p/b/cards.md': `${A}\n\n${B}\n`,
      'other/cards.md': B,
    })
    const result = await scanProjectCards(app, 'p')

    expect(result.uuids).toEqual(new Set(['aaaaaaaa', 'bbbbbbbb']))
    expect(result.duplicateUuids).toEqual(new Set(['aaaaaaaa']))
    expect(result.complete).toBe(false)
  })

  it('includes expected card paths and marks read failures incomplete', async () => {
    const expectedPath = 'p/expected/cards.md'
    const missingPath = 'p/missing/cards.md'
    const { app, cachedRead } = createApp({ [expectedPath]: `${A}\n` })
    cachedRead.mockRejectedValueOnce(new Error('read failed'))

    const failed = await scanProjectCards(app, 'p', [expectedPath, missingPath])
    expect(failed.complete).toBe(false)
    expect(failed.errors).toEqual([
      expect.objectContaining({ path: expectedPath, message: 'read failed' }),
    ])

    cachedRead.mockImplementation(async (file: TFile) =>
      file.path === expectedPath ? `${A}\n` : '',
    )
    const succeeded = await scanProjectCards(app, 'p', [
      expectedPath,
      missingPath,
    ])
    expect(succeeded.complete).toBe(true)
    expect(succeeded.uuids).toEqual(new Set(['aaaaaaaa']))
  })

  it('creates, updates, deletes and reorders cards without changing surrounding text', async () => {
    const path = 'p/a/cards.md'
    const note = '### 说明\n\ninterlude'
    const preserved = `---\ntitle: Cards\n---\n\nprefix\n\n${note}\n\n`
    const original = `${preserved}${A}\n\n${B}\n`
    const { app, files } = createApp({ [path]: original })
    const store = new LearningCardFileStore(app)

    await store.reorderCard(path, 'aaaaaaaa', 1)
    const reordered = files.get(path) ?? ''
    expect(reordered).toBe(`${preserved}${B}\n\n${A}\n`)

    await store.updateCard(path, 'aaaaaaaa', {
      front: 'updated front',
      back: 'updated back',
    })
    expect(files.get(path)).toContain('**正面：** updated front')
    expect(files.get(path)).toContain('**背面：** updated back')
    expect(files.get(path)).toContain('interlude')
    expect(files.get(path)).toContain('card:bbbbbbbb')

    await store.deleteCard(path, 'aaaaaaaa')
    expect(files.get(path)).toContain('interlude')
    expect(files.get(path)?.startsWith(preserved)).toBe(true)
    expect(files.get(path)).not.toContain('card:aaaaaaaa')

    const created = await store.createCard('p', path, 'Chapter', '11111111', {
      front: 'created front',
      back: 'created back',
    })
    expect(created.cardUuid).toMatch(/^[0-9a-f]{8}$/)
    expect(created.front).toBe('created front')
    expect(created.back).toBe('created back')
  })

  it('deletes multiple cards in one file write', async () => {
    const path = 'p/a/cards.md'
    const { app, files, modify } = createApp({
      [path]: `---\ntitle: Cards\n---\n\n${A}\n\n${B}\n`,
    })
    const store = new LearningCardFileStore(app)

    await store.deleteCards(path, ['aaaaaaaa', 'bbbbbbbb'])

    expect(parseCardFile(files.get(path) ?? '').cards).toHaveLength(0)
    expect(modify).toHaveBeenCalledTimes(1)
  })

  it('creates a missing cards.md through Vault with canonical frontmatter', async () => {
    const path = 'p/new/cards.md'
    const { app, adapter, files, create, modify } = createApp({})
    const store = new LearningCardFileStore(app)

    await store.createCard('p', path, '第一章', '11111111')

    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(path, expect.any(String))
    expect(modify).not.toHaveBeenCalled()
    expect(adapter.write).not.toHaveBeenCalled()
    expect(files.get(path)).toMatch(
      /^---\ntitle: 第一章 - 卡片\n---\n\n## 新卡片 /,
    )
  })

  it('detects a concurrent file creation before Vault.create', async () => {
    const path = 'p/new/cards.md'
    const { app, create, fileObjects, files } = createApp({})
    const store = new LearningCardFileStore(app)
    const getAbstractFileByPath = jest.fn(() => {
      if (getAbstractFileByPath.mock.calls.length === 3) {
        const concurrent = new TFile()
        concurrent.path = path
        concurrent.name = 'cards.md'
        fileObjects.set(path, concurrent)
        files.set(path, 'concurrent')
      }
      return fileObjects.get(path) ?? null
    })
    app.vault.getAbstractFileByPath = getAbstractFileByPath

    await expect(
      store.createCard('p', path, '第一章', '11111111'),
    ).rejects.toBeInstanceOf(CardFileConflictError)
    expect(create).not.toHaveBeenCalled()
    expect(files.get(path)).toBe('concurrent')
  })

  it('moves within one file while preserving UUID and changing kp', async () => {
    const path = 'p/a/cards.md'
    const { app, files } = createApp({ [path]: `${A}\n\n${B}\n` })
    const store = new LearningCardFileStore(app)

    await store.moveCard({
      sourcePath: path,
      targetPath: path,
      cardUuid: 'aaaaaaaa',
      kpUuid: '33333333',
      targetIndex: 1,
    })
    const parsed = parseCardFile(files.get(path) ?? '')
    expect(parsed.cards.map((card) => card.cardUuid)).toEqual([
      'bbbbbbbb',
      'aaaaaaaa',
    ])
    expect(parsed.cards[1].kpUuid).toBe('33333333')
  })

  it('moves across files target-first and resumes an intermediate duplicate', async () => {
    const sourcePath = 'p/a/cards.md'
    const targetPath = 'p/b/cards.md'
    const { app, adapter, files, modify } = createApp({
      [sourcePath]: `${A}\n`,
      [targetPath]: `${B}\n`,
    })
    const store = new LearningCardFileStore(app)
    await store.moveCard({
      sourcePath,
      targetPath,
      cardUuid: 'aaaaaaaa',
      kpUuid: '33333333',
    })
    expect(modify.mock.calls.map(([file]) => file.path)).toEqual([
      targetPath,
      sourcePath,
    ])
    expect(adapter.write).not.toHaveBeenCalled()
    expect(files.get(targetPath)).toContain('card:aaaaaaaa kp:33333333')
    expect(files.get(sourcePath)).not.toContain('card:aaaaaaaa')

    files.set(sourcePath, `${A}\n`)
    await store.moveCard({
      sourcePath,
      targetPath,
      cardUuid: 'aaaaaaaa',
      kpUuid: '33333333',
    })
    expect(files.get(sourcePath)).not.toContain('card:aaaaaaaa')
    expect((files.get(targetPath)?.match(/card:aaaaaaaa/g) ?? []).length).toBe(
      1,
    )
  })

  it('moves an ordered card group across multiple files', async () => {
    const firstPath = 'p/a/cards.md'
    const secondPath = 'p/b/cards.md'
    const targetPath = 'p/c/cards.md'
    const C =
      '## C <!--card:cccccccc kp:33333333-->\n\n**正面：** front C\n\n**背面：** back C'
    const { app, files } = createApp({
      [firstPath]: `${A}\n`,
      [secondPath]: `${B}\n`,
      [targetPath]: `${C}\n`,
    })
    const store = new LearningCardFileStore(app)

    await store.moveCards({
      cards: [
        { sourcePath: secondPath, cardUuid: 'bbbbbbbb' },
        { sourcePath: firstPath, cardUuid: 'aaaaaaaa' },
      ],
      targetPath,
      kpUuid: '44444444',
      targetIndex: 0,
    })

    expect(parseCardFile(files.get(targetPath) ?? '').cards).toMatchObject([
      { cardUuid: 'bbbbbbbb', kpUuid: '44444444' },
      { cardUuid: 'aaaaaaaa', kpUuid: '44444444' },
      { cardUuid: 'cccccccc', kpUuid: '33333333' },
    ])
    expect(parseCardFile(files.get(firstPath) ?? '').cards).toHaveLength(0)
    expect(parseCardFile(files.get(secondPath) ?? '').cards).toHaveLength(0)
  })

  it('moves fenced level-two heading content across files intact', async () => {
    const sourcePath = 'p/a/cards.md'
    const targetPath = 'p/b/cards.md'
    const fencedBack = 'before\n\n```md\n## example heading\n```\n\nafter'
    const fencedCard = `## Fenced <!--card:aaaaaaaa kp:11111111-->\n\n**正面：** front\n\n**背面：** ${fencedBack}`
    const { app, files } = createApp({
      [sourcePath]: `${fencedCard}\n`,
      [targetPath]: `${B}\n`,
    })
    const store = new LearningCardFileStore(app)

    await store.moveCard({
      sourcePath,
      targetPath,
      cardUuid: 'aaaaaaaa',
      kpUuid: '33333333',
    })

    const target = parseCardFile(files.get(targetPath) ?? '')
    expect(target.complete).toBe(true)
    expect(
      target.cards.find((card) => card.cardUuid === 'aaaaaaaa'),
    ).toMatchObject({
      kpUuid: '33333333',
      back: fencedBack,
    })
    expect(files.get(sourcePath)).not.toContain('card:aaaaaaaa')
  })

  it('creates a missing move target with canonical frontmatter', async () => {
    const sourcePath = 'p/a/cards.md'
    const targetPath = 'p/new/cards.md'
    const { app, adapter, files, create, modify } = createApp({
      [sourcePath]: `${A}\n`,
    })
    const store = new LearningCardFileStore(app)

    await store.moveCard({
      sourcePath,
      targetPath,
      cardUuid: 'aaaaaaaa',
      kpUuid: '33333333',
      targetChapterTitle: '新章节',
    })

    expect(create).toHaveBeenCalledWith(targetPath, expect.any(String))
    expect(files.get(targetPath)).toMatch(
      /^---\ntitle: 新章节 - 卡片\n---\n\n## A <!--card:aaaaaaaa kp:33333333-->/,
    )
    expect(modify.mock.calls.map(([file]) => file.path)).toEqual([sourcePath])
    expect(adapter.write).not.toHaveBeenCalled()
  })

  it('requires a chapter title when a cross-file target is missing', async () => {
    const sourcePath = 'p/a/cards.md'
    const { app, create } = createApp({ [sourcePath]: `${A}\n` })
    const store = new LearningCardFileStore(app)

    await expect(
      store.moveCard({
        sourcePath,
        targetPath: 'p/new/cards.md',
        cardUuid: 'aaaaaaaa',
        kpUuid: '33333333',
      }),
    ).rejects.toThrow('需要提供目标章节标题')
    expect(create).not.toHaveBeenCalled()
  })

  it('rolls back target when source deletion fails', async () => {
    const sourcePath = 'p/a/cards.md'
    const targetPath = 'p/b/cards.md'
    const { app, modify, files } = createApp({
      [sourcePath]: `${A}\n`,
      [targetPath]: `${B}\n`,
    })
    modify.mockImplementation(async (file: TFile, content: string) => {
      if (file.path === sourcePath) throw new Error('source failed')
      files.set(file.path, content)
    })
    const store = new LearningCardFileStore(app)

    await expect(
      store.moveCard({
        sourcePath,
        targetPath,
        cardUuid: 'aaaaaaaa',
        kpUuid: '33333333',
      }),
    ).rejects.toThrow('source failed')
    expect(files.get(targetPath)).toBe(`${B}\n`)
    expect(files.get(sourcePath)).toBe(`${A}\n`)
  })

  it('deletes a newly created target when source deletion fails', async () => {
    const sourcePath = 'p/a/cards.md'
    const targetPath = 'p/new/cards.md'
    const { app, files, modify, create, deleteFile } = createApp({
      [sourcePath]: `${A}\n`,
    })
    modify.mockRejectedValueOnce(new Error('source failed'))
    const store = new LearningCardFileStore(app)

    await expect(
      store.moveCard({
        sourcePath,
        targetPath,
        cardUuid: 'aaaaaaaa',
        kpUuid: '33333333',
        targetChapterTitle: '新章节',
      }),
    ).rejects.toThrow('source failed')
    expect(create).toHaveBeenCalledTimes(1)
    expect(deleteFile).toHaveBeenCalledTimes(1)
    expect(files.has(targetPath)).toBe(false)
    expect(files.get(sourcePath)).toBe(`${A}\n`)
  })

  it('does not delete a newly created target changed before rollback', async () => {
    const sourcePath = 'p/a/cards.md'
    const targetPath = 'p/new/cards.md'
    const { app, files, modify, deleteFile } = createApp({
      [sourcePath]: `${A}\n`,
    })
    modify.mockImplementation(async (file: TFile) => {
      if (file.path === sourcePath) {
        files.set(targetPath, `${files.get(targetPath)}external\n`)
        throw new Error('source failed')
      }
    })
    const store = new LearningCardFileStore(app)

    await expect(
      store.moveCard({
        sourcePath,
        targetPath,
        cardUuid: 'aaaaaaaa',
        kpUuid: '33333333',
        targetChapterTitle: '新章节',
      }),
    ).rejects.toThrow('目标回滚失败')
    expect(deleteFile).not.toHaveBeenCalled()
    expect(files.get(targetPath)).toContain('external')
    expect(files.get(sourcePath)).toBe(`${A}\n`)
  })

  it('detects full-content CAS changes before writing', async () => {
    const path = 'p/a/cards.md'
    const { app, adapter, read, files, modify } = createApp({
      [path]: `${A}\n`,
    })
    const store = new LearningCardFileStore(app)
    let reads = 0
    read.mockImplementation(async () => {
      reads += 1
      if (reads === 2) files.set(path, `${A}\nexternal\n`)
      return files.get(path) ?? ''
    })

    await expect(store.deleteCard(path, 'aaaaaaaa')).rejects.toBeInstanceOf(
      CardFileConflictError,
    )
    expect(modify).not.toHaveBeenCalled()
    expect(adapter.write).not.toHaveBeenCalled()
  })
})
