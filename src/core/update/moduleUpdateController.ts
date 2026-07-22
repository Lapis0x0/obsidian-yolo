import type { RequestUrlParam, RequestUrlResponse } from 'obsidian'
import { requestUrl } from 'obsidian'

import type { ConfirmedModuleCandidate } from '../modules/moduleInstallationCoordinator'
import type { ModuleService } from '../modules/moduleService'
import type { ModuleRecord } from '../modules/types'

import {
  type ReleaseNotesByLanguage,
  parseReleaseNoteVersion,
  splitReleaseNotesByLanguage,
} from './updateChecker'

export type ModuleUpdateStatus =
  | 'available'
  | 'downloading'
  | 'ready'
  | 'applying'
  | 'error'
  | 'success'

export type ModuleUpdateOffer = Readonly<{
  kind: 'module'
  key: string
  moduleId: string
  name: string
  currentVersion: string
  latestVersion: string
  releaseNotes: ReleaseNotesByLanguage | null
  notesUnavailable: boolean
  status: ModuleUpdateStatus
  progress: number
  error?: string
}>

type ModuleUpdateRequest = (
  request: RequestUrlParam,
) => Promise<RequestUrlResponse>

export type ModuleUpdateControllerOptions = Readonly<{
  service: ModuleService
  getAutoDownloadEnabled(): boolean
  getMutedVersions(): Readonly<Record<string, string>>
  muteVersion(moduleId: string, version: string): Promise<void>
  request?: ModuleUpdateRequest
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
}>

export class ModuleUpdateController {
  private offers: readonly ModuleUpdateOffer[] = Object.freeze([])
  private readonly listeners = new Set<() => void>()
  private readonly dismissedForSession = new Set<string>()
  private readonly candidates = new Map<string, ConfirmedModuleCandidate>()
  private readonly successTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private disposed = false

  constructor(private readonly options: ModuleUpdateControllerOptions) {}

  getSnapshot = (): readonly ModuleUpdateOffer[] => this.offers

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    const previous = new Map(this.offers.map((offer) => [offer.key, offer]))
    const muted = this.options.getMutedVersions()
    const next: ModuleUpdateOffer[] = []
    this.candidates.clear()

    for (const module of this.options.service.getSnapshot().modules) {
      if (!isPromptableUpdate(module)) continue
      const latestVersion = module.catalog!.version
      const key = offerKey(module.id, latestVersion)
      if (
        this.dismissedForSession.has(key) ||
        muted[module.id] === latestVersion
      ) {
        continue
      }
      const candidate = this.options.service.getInstallCandidate(module.id)
      if (!candidate || candidate.expectedVersion !== latestVersion) continue
      this.candidates.set(key, candidate)
      const current = previous.get(key)
      next.push(
        current ??
          Object.freeze({
            kind: 'module',
            key,
            moduleId: module.id,
            name: module.name,
            currentVersion: module.installed!.version,
            latestVersion,
            releaseNotes: null,
            notesUnavailable: false,
            status: 'available',
            progress: 0,
          }),
      )
    }

    this.publish(next)
    await Promise.allSettled(next.map((offer) => this.loadNotes(offer.key)))
    if (this.options.getAutoDownloadEnabled()) {
      for (const offer of this.offers) {
        if (offer.status === 'available') void this.prepare(offer.key)
      }
    }
  }

  dismissForSession(key: string): void {
    this.dismissedForSession.add(key)
    this.publish(this.offers.filter((offer) => offer.key !== key))
  }

  async mute(key: string): Promise<void> {
    const offer = this.find(key)
    await this.options.muteVersion(offer.moduleId, offer.latestVersion)
    this.dismissForSession(key)
  }

  async update(key: string): Promise<void> {
    let offer = this.find(key)
    if (offer.status !== 'ready') {
      await this.prepare(key)
      offer = this.find(key)
      if (offer.status !== 'ready') return
    }
    const candidate = this.requireCandidate(key)
    this.patch(key, { status: 'applying', error: undefined })
    try {
      await this.options.service.install(candidate)
      this.patch(key, { status: 'success', progress: 100, error: undefined })
      const timer = setTimeout(() => this.dismissForSession(key), 1_500)
      this.successTimers.set(key, timer)
    } catch (error) {
      this.patch(key, { status: 'error', error: errorMessage(error) })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const timer of this.successTimers.values()) clearTimeout(timer)
    this.successTimers.clear()
    this.listeners.clear()
    this.candidates.clear()
    this.offers = Object.freeze([])
  }

  private async prepare(key: string): Promise<void> {
    const offer = this.find(key)
    if (
      offer.status === 'downloading' ||
      offer.status === 'ready' ||
      offer.status === 'applying' ||
      offer.status === 'success'
    ) {
      return
    }
    const candidate = this.requireCandidate(key)
    this.patch(key, { status: 'downloading', progress: 0, error: undefined })
    try {
      await this.options.service.prepare(candidate, (progress) => {
        this.patch(key, { progress })
      })
      this.patch(key, { status: 'ready', progress: 100, error: undefined })
    } catch (error) {
      this.patch(key, { status: 'error', error: errorMessage(error) })
    }
  }

  private async loadNotes(key: string): Promise<void> {
    const offer = this.find(key)
    const module = this.options.service
      .getSnapshot()
      .modules.find((value) => value.id === offer.moduleId)
    const descriptor = module?.catalog?.releaseNotes
    if (!descriptor) {
      this.patch(key, { notesUnavailable: true })
      return
    }
    try {
      const releaseNotes = await fetchModuleReleaseNotes({
        descriptor,
        version: offer.latestVersion,
        request: this.options.request ?? requestUrl,
        subtleCrypto: this.options.subtleCrypto,
      })
      this.patch(key, { releaseNotes, notesUnavailable: false })
    } catch {
      this.patch(key, { releaseNotes: null, notesUnavailable: true })
    }
  }

  private find(key: string): ModuleUpdateOffer {
    const offer = this.offers.find((value) => value.key === key)
    if (!offer) throw new Error(`Module update offer is unavailable: ${key}`)
    return offer
  }

  private requireCandidate(key: string): ConfirmedModuleCandidate {
    const candidate = this.candidates.get(key)
    if (!candidate)
      throw new Error(`Module update candidate is unavailable: ${key}`)
    return candidate
  }

  private patch(key: string, patch: Partial<ModuleUpdateOffer>): void {
    if (this.disposed) return
    let changed = false
    const next = this.offers.map((offer) => {
      if (offer.key !== key) return offer
      changed = true
      return Object.freeze({ ...offer, ...patch })
    })
    if (changed) this.publish(next)
  }

  private publish(offers: readonly ModuleUpdateOffer[]): void {
    if (this.disposed) return
    this.offers = Object.freeze(
      [...offers].sort((left, right) =>
        left.moduleId.localeCompare(right.moduleId),
      ),
    )
    for (const listener of [...this.listeners]) listener()
  }
}

export async function fetchModuleReleaseNotes({
  descriptor,
  version,
  request,
  subtleCrypto = globalThis.crypto?.subtle,
}: Readonly<{
  descriptor: Readonly<{ url: string; byteSize: number; sha256: string }>
  version: string
  request: ModuleUpdateRequest
  subtleCrypto?: Pick<SubtleCrypto, 'digest'>
}>): Promise<ReleaseNotesByLanguage> {
  if (!subtleCrypto) throw new Error('Web Crypto SHA-256 is unavailable')
  const response = await request({
    url: descriptor.url,
    method: 'GET',
    throw: false,
  })
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Module release note returned HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(response.arrayBuffer)
  if (bytes.byteLength !== descriptor.byteSize) {
    throw new Error('Module release note byte size mismatch')
  }
  const digest = await subtleCrypto.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
  if (hex !== descriptor.sha256.toLowerCase()) {
    throw new Error('Module release note SHA-256 mismatch')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim()
  if (parseReleaseNoteVersion(text) !== version) {
    throw new Error('Module release note version mismatch')
  }
  const notes = splitReleaseNotesByLanguage(text)
  if (!notes.en || !notes.zh) {
    throw new Error('Module release note must be bilingual')
  }
  return notes
}

function isPromptableUpdate(module: ModuleRecord): boolean {
  return Boolean(
    module.enabled === true &&
      module.status === 'update-available' &&
      module.installed &&
      module.catalog,
  )
}

function offerKey(moduleId: string, version: string): string {
  return `${moduleId}@${version}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
