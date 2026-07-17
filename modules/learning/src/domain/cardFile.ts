import { dump as dumpYaml } from 'js-yaml'
import { v4 as uuidv4 } from 'uuid'

import { formatCardBody, parseCardBody } from './cardFormat'
import type { LearningVaultReadApi } from './learningVaultReadApi'
import { normalizeLearningVaultPath } from './learningVaultReadApi'
import type {
  LearningVaultCasWriteApi,
  LearningVaultFileSnapshot,
} from './learningVaultWriteApi'

const UUID_RE = /^[0-9a-f]{8}$/
const LINKED_CARD_HEADING_RE =
  /^##[ \t]+(.+?)[ \t]+<!--card:([0-9a-fA-F]{8})[ \t]+kp:([0-9a-fA-F]{8})-->[ \t]*$/
const DIRECT_CARD_HEADING_RE =
  /^##[ \t]+(.+?)[ \t]+<!--card:([0-9a-fA-F]{8})-->[ \t]*$/

export type CardFileMode = 'knowledge-linked' | 'chapter-direct'

type CardBlockBase = {
  cardUuid: string
  title: string
  front: string
  back: string
  rawBlock: string
  startLine: number
  startOffset: number
  endOffset: number
}

export type KnowledgeLinkedCardBlock = CardBlockBase & {
  mode: 'knowledge-linked'
  kpUuid: string
}

export type ChapterDirectCardBlock = CardBlockBase & {
  mode: 'chapter-direct'
  kpUuid: null
}

export type CardBlock = KnowledgeLinkedCardBlock | ChapterDirectCardBlock

export type CardFileError = {
  path?: string
  line?: number
  message: string
}

export type CardFileParseResult<T extends CardBlock = CardBlock> = {
  cards: T[]
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
): CardFileParseResult<KnowledgeLinkedCardBlock>
export function parseCardFile(
  content: string,
  options: { mode: 'knowledge-linked'; path?: string },
): CardFileParseResult<KnowledgeLinkedCardBlock>
export function parseCardFile(
  content: string,
  options: { mode: 'chapter-direct'; path?: string },
): CardFileParseResult<ChapterDirectCardBlock>
export function parseCardFile(
  content: string,
  options: { mode: CardFileMode; path?: string },
): CardFileParseResult
export function parseCardFile(
  content: string,
  pathOrOptions?: string | { mode: CardFileMode; path?: string },
): CardFileParseResult {
  const path =
    typeof pathOrOptions === 'string' ? pathOrOptions : pathOrOptions?.path
  const mode =
    typeof pathOrOptions === 'object'
      ? pathOrOptions.mode
      : ('knowledge-linked' as const)
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
    const headingMatch = headingText.match(
      mode === 'knowledge-linked'
        ? LINKED_CARD_HEADING_RE
        : DIRECT_CARD_HEADING_RE,
    )
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
    const sides = parseCardBody(body)
    if (!sides) {
      errors.push({
        path,
        line: startLine,
        message: '卡片正文必须包含唯一的独占行 --- 作为正反面分隔',
      })
      return
    }

    const base = {
      title: headingMatch[1]?.trim() ?? '',
      cardUuid: (headingMatch[2] ?? '').toLowerCase(),
      front: sides.front,
      back: sides.back,
      rawBlock,
      startLine,
      startOffset,
      endOffset,
    }
    cards.push(
      mode === 'knowledge-linked'
        ? {
            ...base,
            mode,
            kpUuid: (headingMatch[3] ?? '').toLowerCase(),
          }
        : { ...base, mode, kpUuid: null },
    )
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
  vault: LearningVaultReadApi,
  projectPath: string,
  expectedCardPaths?: Iterable<string>,
): Promise<ProjectCardScanResult> {
  const root = normalizeLearningVaultPath(projectPath.replace(/\/$/, ''))
  const prefix = `${root}/`
  const discoveredFiles = vault
    .listMarkdownFiles()
    .filter(
      (file) =>
        file.name === 'cards.md' &&
        (file.path === `${root}/cards.md` || file.path.startsWith(prefix)),
    )
  const filesByPath = new Map(discoveredFiles.map((file) => [file.path, file]))
  for (const expectedPath of expectedCardPaths ?? []) {
    const path = normalizeLearningVaultPath(expectedPath)
    const entry = vault.getEntry(path)
    if (entry?.kind === 'file') filesByPath.set(path, entry)
  }
  const uuids = new Set<string>()
  const duplicateUuids = new Set<string>()
  const errors: CardFileError[] = []

  for (const file of filesByPath.values()) {
    try {
      const content = await vault.readText(file.path)
      const parsed = parseCardFile(content, {
        mode: detectCardFileMode(content),
        path: file.path,
      })
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

  constructor(
    private readonly vault: LearningVaultReadApi,
    private readonly writer: LearningVaultCasWriteApi,
  ) {}

  createCard(
    projectPath: string,
    filePath: string,
    chapterTitle: string,
    kpUuid: string,
    content: { front: string; back: string } = { front: '', back: '' },
  ): Promise<CardBlock> {
    return this.createCardInMode(
      projectPath,
      filePath,
      chapterTitle,
      'knowledge-linked',
      kpUuid,
      content,
    )
  }

  createChapterCard(
    projectPath: string,
    filePath: string,
    chapterTitle: string,
    content: { front: string; back: string } = { front: '', back: '' },
  ): Promise<CardBlock> {
    return this.createCardInMode(
      projectPath,
      filePath,
      chapterTitle,
      'chapter-direct',
      null,
      content,
    )
  }

  private createCardInMode(
    projectPath: string,
    filePath: string,
    chapterTitle: string,
    mode: CardFileMode,
    kpUuid: string | null,
    content: { front: string; back: string },
  ): Promise<CardBlock> {
    return this.enqueueWrite(async () => {
      if (mode === 'knowledge-linked') validateUuid(kpUuid ?? '', '知识点')
      const scan = await scanProjectCards(this.vault, projectPath, [filePath])
      if (!scan.complete)
        throw new CardFileFormatError(projectPath, scan.errors)
      let cardUuid = createUuid()
      while (scan.uuids.has(cardUuid)) cardUuid = createUuid()

      const snapshot = await this.readSnapshot(filePath)
      this.assertWritable(filePath, snapshot.content, mode)
      const block = formatCard(
        cardUuid,
        kpUuid,
        '新卡片',
        content.front,
        content.back,
        mode,
      )
      const expected = snapshot.content
      const initialContent = buildCardsContent(chapterTitle)
      const base = snapshot.file ? expected : initialContent
      const next = `${base}${cardAppendSeparator(base)}${block}\n`
      await this.casWrite(filePath, snapshot, next)
      return requireCard(
        parseCardFile(next, { mode, path: filePath }),
        cardUuid,
        filePath,
      )
    })
  }

  deleteCard(
    filePath: string,
    cardUuid: string,
    mode: CardFileMode = 'knowledge-linked',
  ): Promise<void> {
    return this.deleteCards(filePath, [cardUuid], mode)
  }

  deleteCards(
    filePath: string,
    cardUuids: Iterable<string>,
    mode: CardFileMode = 'knowledge-linked',
  ): Promise<void> {
    const uuids = new Set(cardUuids)
    if (uuids.size === 0) return Promise.resolve()
    return this.enqueueWrite(async () => {
      const snapshot = await this.readSnapshot(filePath)
      const expected = snapshot.content
      const parsed = this.assertWritable(filePath, expected, mode)
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
    mode: CardFileMode = 'knowledge-linked',
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const snapshot = await this.readSnapshot(filePath)
      const expected = snapshot.content
      const parsed = this.assertWritable(filePath, expected, mode)
      const card = requireCard(parsed, cardUuid, filePath)
      const changed = formatCard(
        card.cardUuid,
        card.kpUuid,
        card.title,
        content.front,
        content.back,
        mode,
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
    mode: CardFileMode = 'knowledge-linked',
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const snapshot = await this.readSnapshot(filePath)
      const expected = snapshot.content
      const parsed = this.assertWritable(filePath, expected, mode)
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
    return this.moveCardInMode({ ...input, mode: 'knowledge-linked' })
  }

  moveChapterCard(input: {
    sourcePath: string
    targetPath: string
    cardUuid: string
    targetIndex?: number
    targetChapterTitle?: string
  }): Promise<void> {
    return this.moveCardInMode({
      ...input,
      mode: 'chapter-direct',
      kpUuid: null,
    })
  }

  private moveCardInMode(input: {
    sourcePath: string
    targetPath: string
    cardUuid: string
    kpUuid: string | null
    mode: CardFileMode
    targetIndex?: number
    targetChapterTitle?: string
  }): Promise<void> {
    return this.enqueueWrite(async () => {
      if (input.mode === 'knowledge-linked')
        validateUuid(input.kpUuid ?? '', '知识点')
      if (input.sourcePath === input.targetPath) {
        await this.moveWithinFile(input)
        return
      }
      await this.moveAcrossFiles(input)
    })
  }

  moveCards(input: {
    cards: Array<{ sourcePath: string; cardUuid: string }>
    targetPath: string
    kpUuid: string
    targetIndex: number
    targetChapterTitle?: string
  }): Promise<void> {
    return this.moveCardsInMode({ ...input, mode: 'knowledge-linked' })
  }

  moveChapterCards(input: {
    cards: Array<{ sourcePath: string; cardUuid: string }>
    targetPath: string
    targetIndex: number
    targetChapterTitle?: string
  }): Promise<void> {
    return this.moveCardsInMode({
      ...input,
      mode: 'chapter-direct',
      kpUuid: null,
    })
  }

  private moveCardsInMode(input: {
    cards: Array<{ sourcePath: string; cardUuid: string }>
    targetPath: string
    kpUuid: string | null
    mode: CardFileMode
    targetIndex: number
    targetChapterTitle?: string
  }): Promise<void> {
    return this.enqueueWrite(async () => {
      if (input.mode === 'knowledge-linked')
        validateUuid(input.kpUuid ?? '', '知识点')
      if (input.cards.length === 0) return
      const movingUuids = new Set(input.cards.map((card) => card.cardUuid))
      if (movingUuids.size !== input.cards.length) {
        throw new Error('批量移动卡片包含重复 UUID')
      }
      movingUuids.forEach((uuid) => validateUuid(uuid, '卡片'))

      const paths = [
        input.targetPath,
        ...input.cards.map((card) => card.sourcePath),
      ].filter((path, index, all) => all.indexOf(path) === index)
      const snapshots = new Map<string, CardFileSnapshot>()
      const parsedByPath = new Map<string, CardFileParseResult>()
      for (const path of paths) {
        const snapshot = await this.readSnapshot(path)
        snapshots.set(path, snapshot)
        parsedByPath.set(
          path,
          this.assertWritable(path, snapshot.content, input.mode),
        )
      }

      const movingCards = input.cards.map(({ sourcePath, cardUuid }) => {
        const parsed = parsedByPath.get(sourcePath)
        if (!parsed) throw new Error(`找不到源卡片文件：${sourcePath}`)
        return requireCard(parsed, cardUuid, sourcePath)
      })
      const nextByPath = new Map<string, string>()
      for (const path of paths) {
        const snapshot = snapshots.get(path)
        const parsed = parsedByPath.get(path)
        if (!snapshot || !parsed) continue
        nextByPath.set(
          path,
          replaceCardSlots(
            snapshot.content,
            parsed.cards,
            parsed.cards.map((card) =>
              movingUuids.has(card.cardUuid) ? '' : card.rawBlock,
            ),
          ),
        )
      }

      const targetSnapshot = snapshots.get(input.targetPath)
      if (!targetSnapshot)
        throw new Error(`找不到目标卡片文件：${input.targetPath}`)
      if (!targetSnapshot.file && !input.targetChapterTitle?.trim()) {
        throw new Error(
          `目标 cards.md 不存在，需要提供目标章节标题：${input.targetPath}`,
        )
      }
      const targetBase = targetSnapshot.file
        ? (nextByPath.get(input.targetPath) ?? '')
        : buildCardsContent(input.targetChapterTitle ?? '')
      const targetParsed = this.assertWritable(
        input.targetPath,
        targetBase,
        input.mode,
      )
      if (
        input.targetIndex < 0 ||
        input.targetIndex > targetParsed.cards.length
      ) {
        throw new Error(`卡片目标位置越界：${input.targetIndex}`)
      }
      const changedBlocks = movingCards.map((card) =>
        formatCard(
          card.cardUuid,
          input.kpUuid,
          card.title,
          card.front,
          card.back,
          input.mode,
        ),
      )
      nextByPath.set(
        input.targetPath,
        insertCard(
          targetBase,
          targetParsed.cards,
          changedBlocks.join('\n\n'),
          input.targetIndex,
        ),
      )

      const orderedPaths = [
        input.targetPath,
        ...paths.filter((path) => path !== input.targetPath),
      ]
      const written: Array<{
        path: string
        before: CardFileSnapshot
        after: string
        file: LearningVaultFileSnapshot
      }> = []
      try {
        for (const path of orderedPaths) {
          const before = snapshots.get(path)
          const after = nextByPath.get(path)
          if (!before || after === undefined || after === before.content)
            continue
          const file = await this.casWrite(path, before, after)
          written.push({ path, before, after, file })
        }
      } catch (error) {
        try {
          for (const entry of written.reverse()) {
            if (entry.before.file) {
              await this.casWrite(
                entry.path,
                { file: entry.file, content: entry.file.content },
                entry.before.content,
              )
            } else {
              await this.casRevertCreatedFile(
                entry.path,
                entry.file,
                entry.after,
                buildCardsContent(input.targetChapterTitle ?? ''),
              )
            }
          }
        } catch (rollbackError) {
          throw new Error(
            `批量移动卡片失败且回滚失败；源错误：${toErrorMessage(error)}；回滚错误：${toErrorMessage(rollbackError)}`,
          )
        }
        throw error
      }
    })
  }

  private async moveWithinFile(input: {
    sourcePath: string
    cardUuid: string
    kpUuid: string | null
    mode: CardFileMode
    targetIndex?: number
  }): Promise<void> {
    const snapshot = await this.readSnapshot(input.sourcePath)
    const expected = snapshot.content
    const parsed = this.assertWritable(input.sourcePath, expected, input.mode)
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
      input.mode,
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
    kpUuid: string | null
    mode: CardFileMode
    targetIndex?: number
    targetChapterTitle?: string
  }): Promise<void> {
    const sourceSnapshot = await this.readSnapshot(input.sourcePath)
    const targetSnapshot = await this.readSnapshot(input.targetPath)
    const sourceParsed = this.assertWritable(
      input.sourcePath,
      sourceSnapshot.content,
      input.mode,
    )
    const targetParsed = this.assertWritable(
      input.targetPath,
      targetSnapshot.content,
      input.mode,
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
        input.mode,
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
            if (!writtenTargetFile) {
              throw new CardFileConflictError(input.targetPath)
            }
            await this.casWrite(
              input.targetPath,
              { file: writtenTargetFile, content: writtenTargetFile.content },
              targetSnapshot.content,
            )
          } else {
            await this.casRevertCreatedFile(
              input.targetPath,
              writtenTargetFile,
              targetAfterInsert,
              buildCardsContent(input.targetChapterTitle ?? ''),
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

  private assertWritable(
    path: string,
    content: string,
    mode: CardFileMode,
  ): CardFileParseResult {
    const parsed = parseCardFile(content, { mode, path })
    if (!parsed.complete) throw new CardFileFormatError(path, parsed.errors)
    return parsed
  }

  private async readSnapshot(path: string): Promise<CardFileSnapshot> {
    const file = await this.writer.readTextSnapshot(path)
    return file ? { file, content: file.content } : { file: null, content: '' }
  }

  private async casWrite(
    path: string,
    expected: CardFileSnapshot,
    next: string,
  ): Promise<LearningVaultFileSnapshot> {
    if (!expected.file) {
      const created = await this.writer.createTextIfAbsent(path, next)
      if (!created) throw new CardFileConflictError(path)
      return created
    }
    const updated = await this.writer.replaceTextIfUnchanged(
      expected.file,
      next,
    )
    if (!updated) throw new CardFileConflictError(path)
    return updated
  }

  private async casRevertCreatedFile(
    path: string,
    expectedFile: LearningVaultFileSnapshot | null,
    expectedContent: string,
    fallbackContent: string,
  ): Promise<void> {
    if (
      !expectedFile ||
      expectedFile.content !== expectedContent ||
      !(await this.writer.revertOwnedCreatedTextIfUnchanged(
        expectedFile,
        expectedFile,
        fallbackContent,
      ))
    ) {
      throw new CardFileConflictError(path)
    }
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
  file: LearningVaultFileSnapshot | null
  content: string
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
  kpUuid: string | null,
  title: string,
  front: string,
  back: string,
  mode: CardFileMode,
): string {
  const comment =
    mode === 'knowledge-linked'
      ? `<!--card:${cardUuid} kp:${(kpUuid ?? '').toLowerCase()}-->`
      : `<!--card:${cardUuid}-->`
  return `## ${title.trim()} ${comment}\n\n${formatCardBody(front, back)}`
}

function detectCardFileMode(content: string): CardFileMode {
  for (const heading of scanLevelTwoHeadings(content)) {
    if (LINKED_CARD_HEADING_RE.test(heading.text)) return 'knowledge-linked'
    if (DIRECT_CARD_HEADING_RE.test(heading.text)) return 'chapter-direct'
  }
  return 'knowledge-linked'
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
