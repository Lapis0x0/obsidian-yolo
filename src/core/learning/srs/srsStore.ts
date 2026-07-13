import { App, normalizePath } from 'obsidian'
import { Rating, S_MIN, createEmptyCard, fsrs } from 'ts-fsrs'
import type { Card, Grade, RecordLog } from 'ts-fsrs'

import {
  type YoloSettingsLike,
  ensureLearningJsonDbRootDir,
} from '../../paths/yoloManagedData'
import {
  YOLO_LEARNING_SRS_DIR_NAME,
  getYoloJsonDbRootDir,
} from '../../paths/yoloPaths'

import type {
  CardScheduling,
  ReviewRating,
  ReviewResult,
  SrsCardState,
  SrsProjectState,
} from './srsTypes'

const SRS_SCHEMA_VERSION = 2
const scheduler = fsrs()

type FsrsCardCompat = {
  elapsed_days: number
}

const ratingByName: Record<ReviewRating, Grade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

export type SrsReplayEvent = {
  reviewedAt: number
  rating: 1 | 2 | 3 | 4
}

export type SrsProjectMutation = {
  projectSlug: string
}

export function replaySrsEvents(
  events: readonly SrsReplayEvent[],
  introducedAt: Date,
): SrsCardState {
  let card = createEmptyCard(introducedAt)
  for (const event of [...events].sort((a, b) => a.reviewedAt - b.reviewedAt)) {
    const reviewedAt = new Date(event.reviewedAt)
    card = scheduler.repeat(card, reviewedAt)[event.rating as Grade].card
  }
  return toStoredCard(card, introducedAt.toISOString())
}

const toStoredCard = (card: Card, introducedAt: string): SrsCardState => ({
  due: card.due.toISOString(),
  stability: card.stability,
  difficulty: card.difficulty,
  elapsedDays: (card as unknown as FsrsCardCompat).elapsed_days,
  scheduledDays: card.scheduled_days,
  learningSteps: card.learning_steps,
  reps: card.reps,
  lapses: card.lapses,
  state: card.state,
  ...(card.last_review ? { lastReview: card.last_review.toISOString() } : {}),
  introducedAt,
})

export class LearningSrsStore {
  private readonly app: App
  private readonly getSettings: () => YoloSettingsLike | null
  private readonly cache = new Map<string, SrsProjectState>()
  private readonly loadPromises = new Map<string, Promise<SrsProjectState>>()
  private writeQueue: Promise<void> = Promise.resolve()
  private managedDataQueue: Promise<void> = Promise.resolve()
  private ensureDirectoryPromise: {
    key: string
    value: Promise<string>
  } | null = null
  private rootPromise: { key: string; value: Promise<string> } | null = null
  private activeRoot: string | null = null
  private activeRootKey: string | null = null
  private rootGeneration = 0
  private readonly mutationSubscribers = new Set<
    (mutation: SrsProjectMutation) => void
  >()

  constructor(app: App, getSettings: () => YoloSettingsLike | null) {
    this.app = app
    this.getSettings = getSettings
  }

  async getLearningDataRootDir(): Promise<string> {
    const settings = this.getSettings()
    const key = getYoloJsonDbRootDir(settings)
    if (key === this.activeRootKey && this.activeRoot) return this.activeRoot
    let request = this.rootPromise
    if (!request || request.key !== key) {
      const value = this.enqueueManagedDataOperation(() =>
        ensureLearningJsonDbRootDir(this.app, settings),
      )
      request = { key, value }
      this.rootPromise = request
    }

    try {
      const root = await request.value
      if (root !== this.activeRoot || key !== this.activeRootKey) {
        this.activeRoot = root
        this.activeRootKey = key
        this.rootGeneration += 1
        this.cache.clear()
        this.loadPromises.clear()
      }
      return root
    } finally {
      if (this.rootPromise === request) this.rootPromise = null
    }
  }

  runExclusive<R>(operation: () => Promise<R>): Promise<R> {
    return this.enqueueWrite(() => this.enqueueManagedDataOperation(operation))
  }

  subscribe(subscriber: (mutation: SrsProjectMutation) => void): () => void {
    this.mutationSubscribers.add(subscriber)
    return () => this.mutationSubscribers.delete(subscriber)
  }

  initializeProjectState(
    projectSlug: string,
    state: SrsProjectState,
    options: { activateCache?: boolean } = {},
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      this.validateProjectSlug(projectSlug)
      const validated = this.parseProjectState(
        structuredClone(state),
        `${projectSlug}.json`,
      ).state
      await this.writeProjectState(projectSlug, validated)
      if (options.activateCache !== false)
        this.cache.set(projectSlug, validated)
      else this.invalidateProject(projectSlug)
      this.emitMutation(projectSlug)
    })
  }

  activateProjectState(projectSlug: string, state: SrsProjectState): void {
    this.validateProjectSlug(projectSlug)
    this.cache.set(projectSlug, structuredClone(state))
    this.loadPromises.delete(projectSlug)
  }

  invalidateProject(projectSlug: string): void {
    this.cache.delete(projectSlug)
    this.loadPromises.delete(projectSlug)
  }

  deleteProjectState(projectSlug: string): Promise<void> {
    return this.enqueueWrite(async () => {
      const filePath = await this.getProjectFilePath(projectSlug)
      const existed = await this.app.vault.adapter.exists(filePath)
      if (existed) await this.app.vault.adapter.remove(filePath)
      this.invalidateProject(projectSlug)
      if (existed) this.emitMutation(projectSlug)
    })
  }

  getProjectStateFilePath(projectSlug: string): Promise<string> {
    this.validateProjectSlug(projectSlug)
    return this.getProjectFilePath(projectSlug)
  }

  async getProjectState(projectSlug: string): Promise<SrsProjectState> {
    const state = await this.loadProjectState(projectSlug)
    return structuredClone(state)
  }

  reviewCard(
    projectSlug: string,
    cardUuid: string,
    rating: ReviewRating,
    reviewedAt: Date,
  ): Promise<ReviewResult> {
    this.validateCardUuid(cardUuid)
    return this.enqueueWrite(async () => {
      const current = await this.loadProjectState(projectSlug)
      this.assertNotSuspended(current, [cardUuid])
      const existing = current.cards[cardUuid]
      const introducedAt = existing?.introducedAt ?? reviewedAt.toISOString()
      const card = existing
        ? this.toFsrsCard(existing)
        : createEmptyCard(reviewedAt)
      const repeated = scheduler.repeat(card, reviewedAt)
      const nextCard = this.toSrsCardState(
        repeated[ratingByName[rating]].card,
        introducedAt,
      )
      const nextState: SrsProjectState = {
        version: SRS_SCHEMA_VERSION,
        cards: { ...current.cards, [cardUuid]: nextCard },
        suspended: current.suspended,
      }

      await this.writeProjectState(projectSlug, nextState)
      this.cache.set(projectSlug, nextState)
      this.emitMutation(projectSlug)

      return {
        card: structuredClone(nextCard),
        scheduling: this.toScheduling(repeated),
      }
    })
  }

  reviewCards(
    projectSlug: string,
    cardUuids: Iterable<string>,
    rating: ReviewRating,
    reviewedAt: Date,
  ): Promise<void> {
    const uuids = new Set(cardUuids)
    uuids.forEach((uuid) => this.validateCardUuid(uuid))
    if (uuids.size === 0) return Promise.resolve()
    return this.enqueueWrite(async () => {
      const current = await this.loadProjectState(projectSlug)
      this.assertNotSuspended(current, uuids)
      const cards = { ...current.cards }
      uuids.forEach((uuid) => {
        const existing = current.cards[uuid]
        const introducedAt = existing?.introducedAt ?? reviewedAt.toISOString()
        const card = existing
          ? this.toFsrsCard(existing)
          : createEmptyCard(reviewedAt)
        const repeated = scheduler.repeat(card, reviewedAt)
        cards[uuid] = this.toSrsCardState(
          repeated[ratingByName[rating]].card,
          introducedAt,
        )
      })
      const nextState: SrsProjectState = { ...current, cards }
      await this.writeProjectState(projectSlug, nextState)
      this.cache.set(projectSlug, nextState)
      this.emitMutation(projectSlug)
    })
  }

  async getCardScheduling(
    projectSlug: string,
    cardUuid: string,
    now: Date,
  ): Promise<Record<ReviewRating, CardScheduling>> {
    this.validateCardUuid(cardUuid)
    const state = await this.loadProjectState(projectSlug)
    this.assertNotSuspended(state, [cardUuid])
    const card = state.cards[cardUuid]
      ? this.toFsrsCard(state.cards[cardUuid])
      : createEmptyCard(now)
    return this.toScheduling(scheduler.repeat(card, now))
  }

  getCardRetrievability(card: SrsCardState, at: Date): number {
    return scheduler.get_retrievability(this.toFsrsCard(card), at, false)
  }

  async getDueCardUuids(projectSlug: string, now: Date): Promise<Set<string>> {
    const state = await this.loadProjectState(projectSlug)
    return new Set(
      Object.entries(state.cards)
        .filter(
          ([uuid, card]) =>
            !state.suspended.includes(uuid) &&
            new Date(card.due).getTime() <= now.getTime(),
        )
        .map(([uuid]) => uuid),
    )
  }

  async getTodayIntroducedCount(
    projectSlug: string,
    now: Date,
  ): Promise<number> {
    const state = await this.loadProjectState(projectSlug)
    const suspended = new Set(state.suspended)
    return Object.entries(state.cards).filter(
      ([uuid, card]) =>
        !suspended.has(uuid) &&
        this.isSameLocalDay(new Date(card.introducedAt), now),
    ).length
  }

  suspendCards(
    projectSlug: string,
    cardUuids: Iterable<string>,
  ): Promise<void> {
    const uuids = this.validateAndDedupeCardUuids(cardUuids)
    if (uuids.size === 0) return Promise.resolve()
    return this.enqueueWrite(async () => {
      const current = await this.loadProjectState(projectSlug)
      const suspended = [...new Set([...current.suspended, ...uuids])].sort()
      if (suspended.length === current.suspended.length) return
      const nextState: SrsProjectState = { ...current, suspended }
      await this.writeProjectState(projectSlug, nextState)
      this.cache.set(projectSlug, nextState)
      this.emitMutation(projectSlug)
    })
  }

  resumeCards(projectSlug: string, cardUuids: Iterable<string>): Promise<void> {
    const uuids = this.validateAndDedupeCardUuids(cardUuids)
    if (uuids.size === 0) return Promise.resolve()
    return this.enqueueWrite(async () => {
      const current = await this.loadProjectState(projectSlug)
      const suspended = current.suspended.filter((uuid) => !uuids.has(uuid))
      if (suspended.length === current.suspended.length) return
      const nextState: SrsProjectState = { ...current, suspended }
      await this.writeProjectState(projectSlug, nextState)
      this.cache.set(projectSlug, nextState)
      this.emitMutation(projectSlug)
    })
  }

  async isCardSuspended(
    projectSlug: string,
    cardUuid: string,
  ): Promise<boolean> {
    this.validateCardUuid(cardUuid)
    return (await this.loadProjectState(projectSlug)).suspended.includes(
      cardUuid,
    )
  }

  async getSuspendedCardUuids(projectSlug: string): Promise<Set<string>> {
    return new Set((await this.loadProjectState(projectSlug)).suspended)
  }

  removeCards(projectSlug: string, cardUuids: Iterable<string>): Promise<void> {
    const uuids = new Set(cardUuids)
    uuids.forEach((uuid) => this.validateCardUuid(uuid))
    return this.enqueueWrite(async () => {
      const current = await this.loadProjectState(projectSlug)
      const cards = Object.fromEntries(
        Object.entries(current.cards).filter(([uuid]) => !uuids.has(uuid)),
      )
      const suspended = current.suspended.filter((uuid) => !uuids.has(uuid))
      const changed =
        Object.keys(cards).length !== Object.keys(current.cards).length ||
        suspended.length !== current.suspended.length
      if (!changed) return
      const nextState: SrsProjectState = { ...current, cards, suspended }
      await this.writeProjectState(projectSlug, nextState)
      this.cache.set(projectSlug, nextState)
      this.emitMutation(projectSlug)
    })
  }

  pruneOrphanedCards(
    projectSlug: string,
    existingCardUuids: ReadonlySet<string>,
  ): Promise<void> {
    return this.enqueueWrite(async () => {
      const current = await this.loadProjectState(projectSlug)
      const cards = Object.fromEntries(
        Object.entries(current.cards).filter(([uuid]) =>
          existingCardUuids.has(uuid),
        ),
      )
      const suspended = current.suspended.filter((uuid) =>
        existingCardUuids.has(uuid),
      )
      if (
        Object.keys(cards).length === Object.keys(current.cards).length &&
        suspended.length === current.suspended.length
      )
        return
      const nextState: SrsProjectState = { ...current, cards, suspended }
      await this.writeProjectState(projectSlug, nextState)
      this.cache.set(projectSlug, nextState)
      this.emitMutation(projectSlug)
    })
  }

  private enqueueWrite<R>(operation: () => Promise<R>): Promise<R> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private emitMutation(projectSlug: string): void {
    const mutation = { projectSlug }
    for (const subscriber of this.mutationSubscribers) {
      try {
        subscriber(mutation)
      } catch (error) {
        console.error('[YOLO] Learning SRS mutation subscriber failed:', error)
      }
    }
  }

  private enqueueManagedDataOperation<R>(
    operation: () => Promise<R>,
  ): Promise<R> {
    const next = this.managedDataQueue.then(operation, operation)
    this.managedDataQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async loadProjectState(
    projectSlug: string,
  ): Promise<SrsProjectState> {
    this.validateProjectSlug(projectSlug)
    await this.getLearningDataRootDir()
    const generation = this.rootGeneration
    const cached = this.cache.get(projectSlug)
    if (cached) return cached

    const existingLoad = this.loadPromises.get(projectSlug)
    if (existingLoad) return existingLoad

    const load = this.readProjectState(projectSlug)
    this.loadPromises.set(projectSlug, load)
    try {
      const state = await load
      if (generation !== this.rootGeneration) {
        return this.loadProjectState(projectSlug)
      }
      this.cache.set(projectSlug, state)
      return state
    } finally {
      if (this.loadPromises.get(projectSlug) === load) {
        this.loadPromises.delete(projectSlug)
      }
    }
  }

  private async readProjectState(
    projectSlug: string,
  ): Promise<SrsProjectState> {
    const filePath = await this.getProjectFilePath(projectSlug)
    if (!(await this.app.vault.adapter.exists(filePath))) {
      const empty: SrsProjectState = {
        version: SRS_SCHEMA_VERSION,
        cards: {},
        suspended: [],
      }
      return empty
    }

    const content = await this.app.vault.adapter.read(filePath)
    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch {
      throw new Error(`SRS 文件损坏：${filePath}`)
    }
    const { state, migrated } = this.parseProjectState(parsed, filePath)
    if (migrated) await this.writeProjectState(projectSlug, state)
    return state
  }

  private async writeProjectState(
    projectSlug: string,
    state: SrsProjectState,
  ): Promise<void> {
    const filePath = await this.getProjectFilePath(projectSlug)
    await this.app.vault.adapter.write(filePath, JSON.stringify(state, null, 2))
  }

  private async getProjectFilePath(projectSlug: string): Promise<string> {
    const dir = await this.ensureDirectory()
    return normalizePath(`${dir}/${projectSlug}.json`)
  }

  private ensureDirectory(): Promise<string> {
    const key = getYoloJsonDbRootDir(this.getSettings())
    let request = this.ensureDirectoryPromise
    if (!request || request.key !== key) {
      const value = this.ensureDirectoryInternal()
      request = { key, value }
      this.ensureDirectoryPromise = request
    }
    return request.value.finally(() => {
      if (this.ensureDirectoryPromise === request) {
        this.ensureDirectoryPromise = null
      }
    })
  }

  private async ensureDirectoryInternal(): Promise<string> {
    const root = await this.getLearningDataRootDir()
    if (!(await this.app.vault.adapter.exists(root))) {
      await this.app.vault.adapter.mkdir(root)
    }
    const dir = normalizePath(`${root}/${YOLO_LEARNING_SRS_DIR_NAME}`)
    if (!(await this.app.vault.adapter.exists(dir))) {
      await this.app.vault.adapter.mkdir(dir)
    }
    return dir
  }

  private parseProjectState(
    value: unknown,
    filePath: string,
  ): { state: SrsProjectState; migrated: boolean } {
    if (!this.isRecord(value)) {
      throw new Error(`SRS 文件格式无效：${filePath}`)
    }
    if (value.version !== 1 && value.version !== SRS_SCHEMA_VERSION) {
      throw new Error(`SRS 文件版本不受支持，需要迁移：${filePath}`)
    }
    if (!this.isRecord(value.cards)) {
      throw new Error(`SRS 卡片数据格式无效：${filePath}`)
    }

    const cards: Record<string, SrsCardState> = {}
    for (const [uuid, card] of Object.entries(value.cards)) {
      this.validateCardUuid(uuid, filePath)
      cards[uuid] = this.parseCardState(card, filePath, uuid)
    }
    let suspended: string[] = []
    if (value.version === SRS_SCHEMA_VERSION) {
      if (!Array.isArray(value.suspended)) {
        throw new Error(`SRS 暂停卡片数据格式无效：${filePath}`)
      }
      const unique = new Set<string>()
      for (const uuid of value.suspended) {
        if (typeof uuid !== 'string') {
          throw new Error(`SRS 暂停卡片 UUID 无效：${filePath}`)
        }
        this.validateCardUuid(uuid, filePath)
        unique.add(uuid)
      }
      suspended = [...unique].sort()
    }
    return {
      state: { version: SRS_SCHEMA_VERSION, cards, suspended },
      migrated: value.version === 1,
    }
  }

  private assertNotSuspended(
    state: SrsProjectState,
    cardUuids: Iterable<string>,
  ): void {
    const suspended = new Set(state.suspended)
    const blocked = [...cardUuids].filter((uuid) => suspended.has(uuid)).sort()
    if (blocked.length > 0) {
      throw new Error(`暂停卡片不能评分或计算排程：${blocked.join(', ')}`)
    }
  }

  private validateAndDedupeCardUuids(cardUuids: Iterable<string>): Set<string> {
    const uuids = new Set(cardUuids)
    uuids.forEach((uuid) => this.validateCardUuid(uuid))
    return uuids
  }

  private parseCardState(
    value: unknown,
    filePath: string,
    uuid: string,
  ): SrsCardState {
    if (!this.isRecord(value)) {
      throw new Error(`SRS 卡片状态无效：${filePath} (${uuid})`)
    }
    const due = this.parseDate(value.due, 'due', filePath, uuid)
    const lastReview =
      value.lastReview === undefined
        ? undefined
        : this.parseDate(value.lastReview, 'lastReview', filePath, uuid)
    const introducedAt = this.parseDate(
      value.introducedAt,
      'introducedAt',
      filePath,
      uuid,
    )
    const stability = this.parseNumber(
      value.stability,
      'stability',
      filePath,
      uuid,
    )
    const difficulty = this.parseNumber(
      value.difficulty,
      'difficulty',
      filePath,
      uuid,
    )
    const elapsedDays = this.parseNonNegativeNumber(
      value.elapsedDays,
      'elapsedDays',
      filePath,
      uuid,
    )
    const scheduledDays = this.parseNonNegativeNumber(
      value.scheduledDays,
      'scheduledDays',
      filePath,
      uuid,
    )
    const learningSteps = this.parseNonNegativeInteger(
      value.learningSteps,
      'learningSteps',
      filePath,
      uuid,
    )
    const reps = this.parseNonNegativeInteger(
      value.reps,
      'reps',
      filePath,
      uuid,
    )
    const lapses = this.parseNonNegativeInteger(
      value.lapses,
      'lapses',
      filePath,
      uuid,
    )
    const state = this.parseNonNegativeInteger(
      value.state,
      'state',
      filePath,
      uuid,
    )
    if (state > 3) {
      throw new Error(`SRS 字段 state 超出范围：${filePath} (${uuid})`)
    }
    if (lapses > reps) {
      throw new Error(`SRS 字段 lapses 不能大于 reps：${filePath} (${uuid})`)
    }
    if (state === 0) {
      if (
        stability !== 0 ||
        difficulty !== 0 ||
        reps !== 0 ||
        lapses !== 0 ||
        learningSteps !== 0 ||
        lastReview !== undefined
      ) {
        throw new Error(`SRS New 卡片状态无效：${filePath} (${uuid})`)
      }
    } else {
      if (
        stability < S_MIN ||
        difficulty < 1 ||
        difficulty > 10 ||
        reps < 1 ||
        lastReview === undefined
      ) {
        throw new Error(`SRS 记忆状态无效：${filePath} (${uuid})`)
      }
      if (
        new Date(introducedAt).getTime() > new Date(lastReview).getTime() ||
        new Date(lastReview).getTime() > new Date(due).getTime()
      ) {
        throw new Error(`SRS 卡片日期顺序无效：${filePath} (${uuid})`)
      }
    }

    return {
      due,
      stability,
      difficulty,
      elapsedDays,
      scheduledDays,
      learningSteps,
      reps,
      lapses,
      state,
      ...(lastReview ? { lastReview } : {}),
      introducedAt,
    }
  }

  private toFsrsCard(card: SrsCardState): Card {
    return {
      due: new Date(card.due),
      stability: card.stability,
      difficulty: card.difficulty,
      elapsed_days: card.elapsedDays,
      scheduled_days: card.scheduledDays,
      learning_steps: card.learningSteps,
      reps: card.reps,
      lapses: card.lapses,
      state: card.state,
      last_review: card.lastReview ? new Date(card.lastReview) : undefined,
    }
  }

  private toSrsCardState(card: Card, introducedAt: string): SrsCardState {
    return toStoredCard(card, introducedAt)
  }

  private toScheduling(
    repeated: RecordLog,
  ): Record<ReviewRating, CardScheduling> {
    return {
      again: this.toCardScheduling(repeated[Rating.Again].card),
      hard: this.toCardScheduling(repeated[Rating.Hard].card),
      good: this.toCardScheduling(repeated[Rating.Good].card),
      easy: this.toCardScheduling(repeated[Rating.Easy].card),
    }
  }

  private toCardScheduling(card: Card): CardScheduling {
    return { due: new Date(card.due), scheduledDays: card.scheduled_days }
  }

  private parseDate(
    value: unknown,
    field: string,
    filePath: string,
    uuid: string,
  ): string {
    if (typeof value !== 'string' || Number.isNaN(new Date(value).getTime())) {
      throw new Error(`SRS 日期字段 ${field} 无效：${filePath} (${uuid})`)
    }
    if (new Date(value).toISOString() !== value) {
      throw new Error(
        `SRS 日期字段 ${field} 必须是 ISO 8601：${filePath} (${uuid})`,
      )
    }
    return value
  }

  private parseNumber(
    value: unknown,
    field: string,
    filePath: string,
    uuid: string,
  ): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`SRS 数值字段 ${field} 无效：${filePath} (${uuid})`)
    }
    return value
  }

  private parseNonNegativeNumber(
    value: unknown,
    field: string,
    filePath: string,
    uuid: string,
  ): number {
    const parsed = this.parseNumber(value, field, filePath, uuid)
    if (parsed < 0) {
      throw new Error(`SRS 数值字段 ${field} 不能为负数：${filePath} (${uuid})`)
    }
    return parsed
  }

  private parseNonNegativeInteger(
    value: unknown,
    field: string,
    filePath: string,
    uuid: string,
  ): number {
    const parsed = this.parseNonNegativeNumber(value, field, filePath, uuid)
    if (!Number.isInteger(parsed)) {
      throw new Error(`SRS 数值字段 ${field} 必须为整数：${filePath} (${uuid})`)
    }
    return parsed
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  private isSameLocalDay(left: Date, right: Date): boolean {
    return (
      left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() &&
      left.getDate() === right.getDate()
    )
  }

  private validateProjectSlug(projectSlug: string): void {
    if (
      projectSlug.length === 0 ||
      projectSlug === '.' ||
      projectSlug === '..' ||
      projectSlug.includes('/') ||
      projectSlug.includes('\\')
    ) {
      throw new Error(`无效的学习项目 slug：${projectSlug}`)
    }
  }

  private validateCardUuid(cardUuid: string, filePath?: string): void {
    if (!/^[0-9a-f]{8}$/.test(cardUuid)) {
      throw new Error(
        filePath
          ? `SRS 卡片 UUID 无效：${filePath} (${cardUuid})`
          : `无效的卡片 UUID：${cardUuid}`,
      )
    }
  }
}
