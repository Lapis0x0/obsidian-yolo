import { dump as dumpYaml } from 'js-yaml'
import { TFile, normalizePath } from 'obsidian'
import type { App } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

const UUID_RE = /^[0-9a-f]{8}$/
const CARD_HEADING_RE =
  /^##[ \t]+(.+?)[ \t]+<!--card:([0-9a-fA-F]{8})[ \t]+kp:([0-9a-fA-F]{8})-->[ \t]*$/

export type CardBlock = {
  cardUuid: string
  kpUuid: string
  title: string
  front: string
  back: string
  rawBlock: string
  startLine: number
  startOffset: number
  endOffset: number
}

export type CardFileError = {
  path?: string
  line?: number
  message: string
}

export type CardFileParseResult = {
  cards: CardBlock[]
  complete: boolean
  errors: CardFileError[]
  duplicateUuids: Set<string>
}

export type ProjectCardScanResult = {
  uuids: Set<string>
  complete: boolean
  errors: CardFileError[]
  duplicateUuids: Set<string>
}

export class CardFileConflictError extends Error {
  constructor(path: string) {
    super(`cards.md 已被并发修改：${path}`)
    this.name = 'CardFileConflictError'
  }
}

export class CardFileFormatError extends Error {
  readonly errors: CardFileError[]

  constructor(path: string, errors: CardFileError[]) {
    super(`cards.md 格式无效：${path}`)
    this.name = 'CardFileFormatError'
    this.errors = errors
  }
}

export function parseCardFile(
  content: string,
  path?: string,
): CardFileParseResult {
  const headings = scanLevelTwoHeadings(content)
  const cards: CardBlock[] = []
  const errors: CardFileError[] = []
  const encounteredUuids: string[] = []

  headings.forEach((heading, index) => {
    const headingText = heading.text

    const startOffset = heading.offset
    const nextOffset = headings[index + 1]?.offset ?? content.length
    let endOffset = nextOffset
    while (endOffset > startOffset && /\s/.test(content[endOffset - 1] ?? '')) {
      endOffset -= 1
    }
    const rawBlock = content.slice(startOffset, endOffset)
    const startLine = lineAtOffset(content, startOffset)
    const headingMatch = headingText.match(CARD_HEADING_RE)
    if (!headingMatch) {
      errors.push({
        path,
        line: startLine,
        message: 'cards.md 中的二级标题必须是合法卡片标题',
      })
      return
    }
    encounteredUuids.push((headingMatch[2] ?? '').toLowerCase())

    const body = rawBlock.slice(headingText.length).replace(/^\r?\n/, '')
    const bodyMatch = body.match(
      /^\s*\*\*正面：\*\*[ \t]*([\s\S]*?)\r?\n\s*\r?\n\*\*背面：\*\*[ \t]*([\s\S]*?)\s*$/,
    )
    if (!bodyMatch) {
      errors.push({
        path,
        line: startLine,
        message: '卡片正文必须依次包含正面和背面标记，并以空行分隔',
      })
      return
    }

    cards.push({
      title: headingMatch[1]?.trim() ?? '',
      cardUuid: (headingMatch[2] ?? '').toLowerCase(),
      kpUuid: (headingMatch[3] ?? '').toLowerCase(),
      front: bodyMatch[1]?.trim() ?? '',
      back: bodyMatch[2]?.trim() ?? '',
      rawBlock,
      startLine,
      startOffset,
      endOffset,
    })
  })

  const counts = new Map<string, number>()
  for (const uuid of encounteredUuids) {
    counts.set(uuid, (counts.get(uuid) ?? 0) + 1)
  }
  const duplicateUuids = new Set(
    [...counts].filter(([, count]) => count > 1).map(([uuid]) => uuid),
  )
  for (const uuid of duplicateUuids) {
    errors.push({ path, message: `card UUID 重复：${uuid}` })
  }

  return { cards, complete: errors.length === 0, errors, duplicateUuids }
}

export async function scanProjectCards(
  app: App,
  projectPath: string,
  expectedCardPaths?: Iterable<string>,
): Promise<ProjectCardScanResult> {
  const root = normalizePath(projectPath.replace(/\/$/, ''))
  const prefix = `${root}/`
  const discoveredFiles = app.vault
    .getMarkdownFiles()
    .filter(
      (file) =>
        file.name === 'cards.md' &&
        (file.path === `${root}/cards.md` || file.path.startsWith(prefix)),
    )
  const filesByPath = new Map(discoveredFiles.map((file) => [file.path, file]))
  for (const expectedPath of expectedCardPaths ?? []) {
    const path = normalizePath(expectedPath)
    const abstractFile = app.vault.getAbstractFileByPath(path)
    if (abstractFile instanceof TFile) filesByPath.set(path, abstractFile)
  }
  const uuids = new Set<string>()
  const duplicateUuids = new Set<string>()
  const errors: CardFileError[] = []

  for (const file of filesByPath.values()) {
    try {
      const parsed = parseCardFile(await app.vault.cachedRead(file), file.path)
      errors.push(...parsed.errors)
      parsed.duplicateUuids.forEach((uuid) => duplicateUuids.add(uuid))
      for (const card of parsed.cards) {
        if (uuids.has(card.cardUuid)) duplicateUuids.add(card.cardUuid)
        uuids.add(card.cardUuid)
      }
    } catch (error) {
      errors.push({
        path: file.path,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const uuid of duplicateUuids) {
    if (!errors.some((error) => error.message === `card UUID 重复：${uuid}`)) {
      errors.push({ message: `card UUID 重复：${uuid}` })
    }
  }
  return {
    uuids,
    complete: errors.length === 0 && duplicateUuids.size === 0,
    errors,
    duplicateUuids,
  }
}

export class LearningCardFileStore {
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly app: App) {}

  createCard(
    projectPath: string,
    filePath: string,
    chapterTitle: string,
    kpUuid: string,
    content: { front: string; back: string } = { front: '', back: '' },
  ): Promise<CardBlock> {
    return this.enqueueWrite(async () => {
      validateUuid(kpUuid, '知识点')
      const scan = await scanProjectCards(this.app, projectPath, [filePath])
      if (!scan.complete)
        throw new CardFileFormatError(projectPath, scan.errors)
      let cardUuid = createUuid()
      while (scan.uuids.has(cardUuid)) cardUuid = createUuid()

      const snapshot = await this.readSnapshot(filePath)
      this.assertWritable(filePath, snapshot.content)
      const block = formatCard(
        cardUuid,
        kpUuid,
        '新卡片',
        content.front,
        content.back,
      )
      const expected = snapshot.content
      const initialContent = buildCardsContent(chapterTitle)
      const base = snapshot.file ? expected : initialContent
      const next = `${base}${cardAppendSeparator(base)}${block}\n`
      await this.casWrite(filePath, snapshot, next)
      return requireCard(parseCardFile(next, filePath), cardUuid, filePath)
    })
  }

  deleteCard(filePath: string, cardUuid: string): Promise<void> {
    return this.deleteCards(filePath, [cardUuid])
  }

  deleteCards(filePath: string, cardUuids: Iterable<string>): Promise<void> {
    const uuids = new Set(cardUuids)
    if (uuids.size === 0) return Promise.resolve()
    return this.enqueueWrite(async () => {
      const snapshot = await this.readSnapshot(filePath)
      const expected = snapshot.content
      const parsed = this.assertWritable(filePath, expected)
      uuids.forEach((uuid) => requireCard(parsed, uuid, filePath))
      await this.casWrite(
        filePath,
        snapshot,
        replaceCardSlots(
          expected,
          parsed.cards,
          parsed.cards.map((card) =>
            uuids.has(card.cardUuid) ? '' : card.rawBlock,
          ),
        ),
      )
    })
  }

  updateCard(
    filePath: string,
    cardUuid: string,
    content: { front: string; back: string },
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const snapshot = await this.readSnapshot(filePath)
      const expected = snapshot.content
      const parsed = this.assertWritable(filePath, expected)
      const card = requireCard(parsed, cardUuid, filePath)
      const changed = formatCard(
        card.cardUuid,
        card.kpUuid,
        card.title,
        content.front,
        content.back,
      )
      if (changed === card.rawBlock) return
      const blocks = parsed.cards.map((entry) =>
        entry.cardUuid === cardUuid ? changed : entry.rawBlock,
      )
      await this.casWrite(
        filePath,
        snapshot,
        replaceCardSlots(expected, parsed.cards, blocks),
      )
    })
  }

  reorderCard(
    filePath: string,
    cardUuid: string,
    targetIndex: number,
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const snapshot = await this.readSnapshot(filePath)
      const expected = snapshot.content
      const parsed = this.assertWritable(filePath, expected)
      const sourceIndex = parsed.cards.findIndex(
        (card) => card.cardUuid === cardUuid,
      )
      if (sourceIndex < 0) throw new Error(`找不到卡片：${cardUuid}`)
      if (targetIndex < 0 || targetIndex >= parsed.cards.length) {
        throw new Error(`卡片目标位置越界：${targetIndex}`)
      }
      if (sourceIndex === targetIndex) return
      const blocks = parsed.cards.map((card) => card.rawBlock)
      const [moved] = blocks.splice(sourceIndex, 1)
      blocks.splice(targetIndex, 0, moved)
      await this.casWrite(
        filePath,
        snapshot,
        replaceCardSlots(expected, parsed.cards, blocks),
      )
    })
  }

  moveCard(input: {
    sourcePath: string
    targetPath: string
    cardUuid: string
    kpUuid: string
    targetIndex?: number
    targetChapterTitle?: string
  }): Promise<void> {
    return this.enqueueWrite(async () => {
      validateUuid(input.kpUuid, '知识点')
      if (input.sourcePath === input.targetPath) {
        await this.moveWithinFile(input)
        return
      }
      await this.moveAcrossFiles(input)
    })
  }

  private async moveWithinFile(input: {
    sourcePath: string
    cardUuid: string
    kpUuid: string
    targetIndex?: number
  }): Promise<void> {
    const snapshot = await this.readSnapshot(input.sourcePath)
    const expected = snapshot.content
    const parsed = this.assertWritable(input.sourcePath, expected)
    const sourceIndex = parsed.cards.findIndex(
      (card) => card.cardUuid === input.cardUuid,
    )
    if (sourceIndex < 0) throw new Error(`找不到卡片：${input.cardUuid}`)
    const targetIndex = input.targetIndex ?? sourceIndex
    if (targetIndex < 0 || targetIndex >= parsed.cards.length) {
      throw new Error(`卡片目标位置越界：${targetIndex}`)
    }
    const blocks = parsed.cards.map((card) => card.rawBlock)
    const [source] = parsed.cards.slice(sourceIndex, sourceIndex + 1)
    const changed = formatCard(
      source.cardUuid,
      input.kpUuid,
      source.title,
      source.front,
      source.back,
    )
    blocks.splice(sourceIndex, 1)
    blocks.splice(targetIndex, 0, changed)
    const next = replaceCardSlots(expected, parsed.cards, blocks)
    if (next !== expected) await this.casWrite(input.sourcePath, snapshot, next)
  }

  private async moveAcrossFiles(input: {
    sourcePath: string
    targetPath: string
    cardUuid: string
    kpUuid: string
    targetIndex?: number
    targetChapterTitle?: string
  }): Promise<void> {
    const sourceSnapshot = await this.readSnapshot(input.sourcePath)
    const targetSnapshot = await this.readSnapshot(input.targetPath)
    const sourceParsed = this.assertWritable(
      input.sourcePath,
      sourceSnapshot.content,
    )
    const targetParsed = this.assertWritable(
      input.targetPath,
      targetSnapshot.content,
    )
    const source = sourceParsed.cards.find(
      (card) => card.cardUuid === input.cardUuid,
    )
    const target = targetParsed.cards.find(
      (card) => card.cardUuid === input.cardUuid,
    )
    if (!source && target) return
    if (!source) throw new Error(`找不到源卡片：${input.cardUuid}`)
    if (
      target &&
      (target.title !== source.title ||
        target.front !== source.front ||
        target.back !== source.back ||
        target.kpUuid !== input.kpUuid)
    ) {
      throw new Error(
        `目标文件中存在内容不一致的同 UUID 卡片：${input.cardUuid}`,
      )
    }

    let targetAfterInsert = targetSnapshot.content
    let writtenTargetFile = targetSnapshot.file
    if (!target) {
      const changedBlock = formatCard(
        source.cardUuid,
        input.kpUuid,
        source.title,
        source.front,
        source.back,
      )
      if (!targetSnapshot.file && !input.targetChapterTitle?.trim()) {
        throw new Error(
          `目标 cards.md 不存在，需要提供目标章节标题：${input.targetPath}`,
        )
      }
      const targetBase = targetSnapshot.file
        ? targetSnapshot.content
        : buildCardsContent(input.targetChapterTitle ?? '')
      targetAfterInsert = insertCard(
        targetBase,
        targetParsed.cards,
        changedBlock,
        input.targetIndex,
      )
      writtenTargetFile = await this.casWrite(
        input.targetPath,
        targetSnapshot,
        targetAfterInsert,
      )
    }

    try {
      await this.casWrite(
        input.sourcePath,
        sourceSnapshot,
        sourceSnapshot.content.slice(0, source.startOffset) +
          sourceSnapshot.content.slice(source.endOffset),
      )
    } catch (error) {
      if (!target) {
        try {
          if (targetSnapshot.file) {
            await this.casWrite(
              input.targetPath,
              { file: targetSnapshot.file, content: targetAfterInsert },
              targetSnapshot.content,
            )
          } else {
            await this.casDeleteCreatedFile(
              input.targetPath,
              writtenTargetFile,
              targetAfterInsert,
            )
          }
        } catch (rollbackError) {
          const sourceMessage = toErrorMessage(error)
          const rollbackMessage = toErrorMessage(rollbackError)
          throw new Error(
            `移动卡片失败且目标回滚失败：${input.cardUuid}；源错误：${sourceMessage}；回滚错误：${rollbackMessage}`,
          )
        }
      }
      throw error
    }
  }

  private assertWritable(path: string, content: string): CardFileParseResult {
    const parsed = parseCardFile(content, path)
    if (!parsed.complete) throw new CardFileFormatError(path, parsed.errors)
    return parsed
  }

  private async readSnapshot(path: string): Promise<CardFileSnapshot> {
    const normalized = normalizePath(path)
    const abstractFile = this.app.vault.getAbstractFileByPath(normalized)
    if (!abstractFile) return { file: null, content: '' }
    if (!(abstractFile instanceof TFile)) {
      throw new Error(`cards.md 路径不是文件：${normalized}`)
    }
    return {
      file: abstractFile,
      content: await this.app.vault.read(abstractFile),
    }
  }

  private async casWrite(
    path: string,
    expected: CardFileSnapshot,
    next: string,
  ): Promise<TFile> {
    const normalized = normalizePath(path)
    const currentFile = this.app.vault.getAbstractFileByPath(normalized)
    if (!expected.file) {
      if (currentFile) throw new CardFileConflictError(normalized)
      return this.app.vault.create(normalized, next)
    }
    if (currentFile !== expected.file)
      throw new CardFileConflictError(normalized)
    const current = await this.app.vault.read(expected.file)
    if (current !== expected.content)
      throw new CardFileConflictError(normalized)
    await this.app.vault.modify(expected.file, next)
    return expected.file
  }

  private async casDeleteCreatedFile(
    path: string,
    expectedFile: TFile | null,
    expectedContent: string,
  ): Promise<void> {
    const normalized = normalizePath(path)
    const currentFile = this.app.vault.getAbstractFileByPath(normalized)
    if (!expectedFile || currentFile !== expectedFile) {
      throw new CardFileConflictError(normalized)
    }
    const current = await this.app.vault.read(expectedFile)
    if (current !== expectedContent) throw new CardFileConflictError(normalized)
    // eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- Transaction rollback must restore the original absent-file state.
    await this.app.vault.delete(expectedFile)
  }

  private enqueueWrite<R>(operation: () => Promise<R>): Promise<R> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

type CardFileSnapshot = {
  file: TFile | null
  content: string
}

const storesByApp = new WeakMap<App, LearningCardFileStore>()

export function getLearningCardFileStore(app: App): LearningCardFileStore {
  const existing = storesByApp.get(app)
  if (existing) return existing
  const store = new LearningCardFileStore(app)
  storesByApp.set(app, store)
  return store
}

function insertCard(
  content: string,
  cards: CardBlock[],
  block: string,
  targetIndex = cards.length,
): string {
  if (targetIndex < 0 || targetIndex > cards.length) {
    throw new Error(`卡片目标位置越界：${targetIndex}`)
  }
  if (targetIndex < cards.length) {
    const offset = cards[targetIndex].startOffset
    return `${content.slice(0, offset)}${block}\n\n${content.slice(offset)}`
  }
  return `${content}${cardAppendSeparator(content)}${block}\n`
}

function replaceCardSlots(
  content: string,
  cards: CardBlock[],
  blocks: string[],
): string {
  let result = ''
  let offset = 0
  cards.forEach((card, index) => {
    result += content.slice(offset, card.startOffset) + blocks[index]
    offset = card.endOffset
  })
  return result + content.slice(offset)
}

function formatCard(
  cardUuid: string,
  kpUuid: string,
  title: string,
  front: string,
  back: string,
): string {
  return `## ${title.trim()} <!--card:${cardUuid} kp:${kpUuid.toLowerCase()}-->\n\n**正面：** ${front.trim()}\n\n**背面：** ${back.trim()}`
}

function buildCardsContent(chapterTitle: string): string {
  const yaml = dumpYaml(
    { title: `${chapterTitle.trim()} - 卡片` },
    { lineWidth: -1 },
  ).trimEnd()
  return `---\n${yaml}\n---\n`
}

function cardAppendSeparator(content: string): string {
  if (content.length === 0 || content.endsWith('\n\n')) return ''
  return content.endsWith('\n') ? '\n' : '\n\n'
}

function requireCard(
  parsed: CardFileParseResult,
  uuid: string,
  path: string,
): CardBlock {
  validateUuid(uuid, '卡片')
  const card = parsed.cards.find((entry) => entry.cardUuid === uuid)
  if (!card) throw new Error(`找不到卡片：${path} (${uuid})`)
  return card
}

function validateUuid(uuid: string, label: string): void {
  if (!UUID_RE.test(uuid)) throw new Error(`${label} UUID 无效：${uuid}`)
}

function createUuid(): string {
  return uuidv4().replace(/-/g, '').slice(0, 8)
}

function lineAtOffset(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === '\n') line += 1
  }
  return line
}

function scanLevelTwoHeadings(
  content: string,
): Array<{ text: string; offset: number }> {
  const headings: Array<{ text: string; offset: number }> = []
  let fence: { marker: '`' | '~'; length: number } | null = null
  let offset = 0

  for (const lineWithEnding of content.match(/.*(?:\n|$)/g) ?? []) {
    if (lineWithEnding.length === 0) break
    const line = lineWithEnding.replace(/\r?\n$/, '')
    if (fence) {
      if (isClosingFence(line, fence)) fence = null
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/)
      if (opening) {
        const delimiter = opening[1] ?? ''
        fence = {
          marker: delimiter[0] as '`' | '~',
          length: delimiter.length,
        }
      } else if (/^##(?:[ \t]+.*)?$/.test(line)) {
        headings.push({ text: line, offset })
      }
    }
    offset += lineWithEnding.length
  }
  return headings
}

function isClosingFence(
  line: string,
  fence: { marker: '`' | '~'; length: number },
): boolean {
  const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/)
  return (
    match?.[1]?.[0] === fence.marker && (match[1]?.length ?? 0) >= fence.length
  )
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
