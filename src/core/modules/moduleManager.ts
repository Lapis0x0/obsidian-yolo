import type { ModuleFailure } from './moduleFailure'
import { compareModuleVersions } from './officialModuleCatalog'
import type {
  InstalledModuleState,
  InstalledModuleStateSource,
  ModuleCatalogEntry,
  ModuleCatalogSource,
  ModuleIntentState,
  ModuleIntentStateSource,
  ModuleManagerSnapshot,
  ModuleRecord,
  ModuleStatus,
} from './types'

export type ModuleManagerOptions = {
  catalogSource: ModuleCatalogSource
  installedStateSource: InstalledModuleStateSource
  intentStateSource?: ModuleIntentStateSource
  getModuleFailure?(moduleId: string): ModuleFailure | undefined
}

const EMPTY_ERRORS = Object.freeze({})
const EMPTY_MODULES = Object.freeze([]) as ReadonlyArray<ModuleRecord>
const EMPTY_CATALOG = Object.freeze([]) as ReadonlyArray<ModuleCatalogEntry>
const EMPTY_INSTALLED = Object.freeze([]) as ReadonlyArray<InstalledModuleState>
const EMPTY_INTENT = Object.freeze([]) as ReadonlyArray<ModuleIntentState>
const INITIAL_SNAPSHOT: ModuleManagerSnapshot = Object.freeze({
  status: 'loading',
  modules: EMPTY_MODULES,
  errors: EMPTY_ERRORS,
})

export const EMPTY_MODULE_CATALOG_SOURCE: ModuleCatalogSource = Object.freeze({
  load: async () => [],
})

export const EMPTY_INSTALLED_MODULE_STATE_SOURCE: InstalledModuleStateSource =
  Object.freeze({
    load: async () => [],
  })

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function indexById<T extends { id: string }>(
  values: ReadonlyArray<T>,
  sourceName: string,
): Map<string, T> {
  const result = new Map<string, T>()
  for (const value of values) {
    if (!value.id) throw new Error(`${sourceName} returned an empty module id`)
    if (result.has(value.id)) {
      throw new Error(
        `${sourceName} returned duplicate module id "${value.id}"`,
      )
    }
    result.set(value.id, value)
  }
  return result
}

function resolveStatus(
  catalog: ModuleCatalogEntry | undefined,
  installed: InstalledModuleState | undefined,
): ModuleStatus {
  if (!installed) return 'available'
  if (installed.error) return 'failed'
  if (installed.pendingVersion) return 'activation-pending'
  if (installed.disabled) return 'disabled'
  if (
    catalog &&
    compareModuleVersions(installed.version, catalog.version) < 0
  ) {
    return 'update-available'
  }
  if (installed.active) return 'active'
  return 'installed'
}

function buildRecords(
  catalogValues: ReadonlyArray<ModuleCatalogEntry>,
  installedValues: ReadonlyArray<InstalledModuleState>,
  intentValues: ReadonlyArray<ModuleIntentState>,
  getModuleFailure?: (moduleId: string) => ModuleFailure | undefined,
): ReadonlyArray<ModuleRecord> {
  const catalogById = indexById(catalogValues, 'Catalog source')
  const installedById = indexById(installedValues, 'Installed-state source')
  const intentById = indexById(intentValues, 'Intent-state source')
  const ids = new Set([...catalogById.keys(), ...installedById.keys()])
  return Object.freeze(
    [...ids].sort().map((id) => {
      const catalogValue = catalogById.get(id)
      const installedValue = installedById.get(id)
      const intentValue = intentById.get(id)
      const catalog = catalogValue
        ? Object.freeze({ ...catalogValue })
        : undefined
      const installed = installedValue
        ? Object.freeze({ ...installedValue })
        : undefined
      const intent = intentValue ? Object.freeze({ ...intentValue }) : undefined
      const failure =
        intent?.state === 'enabled' ? getModuleFailure?.(id) : undefined
      const status = failure
        ? 'failed'
        : intent?.state === 'disabled'
          ? 'disabled'
          : resolveStatus(catalog, installed)
      return Object.freeze({
        id,
        name: catalog?.name ?? id,
        description: catalog?.description ?? '',
        version: installed?.version ?? catalog?.version ?? '',
        ...(catalog && status === 'update-available'
          ? { availableVersion: catalog.version }
          : {}),
        ...(installed?.pendingVersion
          ? { pendingVersion: installed.pendingVersion }
          : {}),
        ...(failure
          ? { error: failure.detail, failure }
          : installed?.error
            ? { error: installed.error }
            : {}),
        ...(catalog?.compatibilityIssues
          ? { compatibilityIssues: catalog.compatibilityIssues }
          : {}),
        status,
        ...(intent
          ? {
              desiredInstalled: intent.state !== 'uninstalled',
              enabled: intent.state === 'enabled',
            }
          : {}),
        ...(catalog ? { catalog } : {}),
        ...(installed ? { installed } : {}),
      })
    }),
  )
}

/** External-store compatible read model for module availability and state. */
export class ModuleManager {
  private snapshot = INITIAL_SNAPSHOT
  private readonly listeners = new Set<() => void>()
  private catalog: ReadonlyArray<ModuleCatalogEntry> = EMPTY_CATALOG
  private installed: ReadonlyArray<InstalledModuleState> = EMPTY_INSTALLED
  private intent: ReadonlyArray<ModuleIntentState> = EMPTY_INTENT
  private refreshQueue: Promise<void> = Promise.resolve()
  private refreshGeneration = 0
  private disposed = false

  constructor(private readonly options: ModuleManagerOptions) {}

  getSnapshot = (): ModuleManagerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const generation = ++this.refreshGeneration
    this.publish('loading', this.snapshot.modules, EMPTY_ERRORS)
    const operation = this.refreshQueue.then(() => this.refreshOnce(generation))
    this.refreshQueue = operation.catch(() => undefined)
    return operation
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.catalog = EMPTY_CATALOG
    this.installed = EMPTY_INSTALLED
    this.intent = EMPTY_INTENT
    this.snapshot = INITIAL_SNAPSHOT
  }

  private async refreshOnce(generation: number): Promise<void> {
    if (this.disposed) return
    const [catalogResult, installedResult] = await Promise.allSettled([
      this.options.catalogSource.load(),
      this.options.installedStateSource.load(),
    ])
    if (this.disposed) return

    const errors: { catalog?: string; installed?: string; intent?: string } = {}
    if (catalogResult.status === 'fulfilled') {
      try {
        indexById(catalogResult.value, 'Catalog source')
        this.catalog = catalogResult.value
      } catch (error) {
        errors.catalog = errorMessage(error)
      }
    } else {
      errors.catalog = errorMessage(catalogResult.reason)
    }
    if (installedResult.status === 'fulfilled') {
      try {
        indexById(installedResult.value, 'Installed-state source')
        this.installed = installedResult.value
      } catch (error) {
        errors.installed = errorMessage(error)
      }
    } else {
      errors.installed = errorMessage(installedResult.reason)
    }

    let nextIntent: ReadonlyArray<ModuleIntentState> | undefined
    if (this.options.intentStateSource) {
      const moduleIds = [
        ...new Set([
          ...this.catalog.map(({ id }) => id),
          ...this.installed.map(({ id }) => id),
        ]),
      ].sort()
      try {
        const intent = await this.options.intentStateSource.load(moduleIds)
        if (this.disposed) return
        const intentById = indexById(intent, 'Intent-state source')
        for (const id of intentById.keys()) {
          if (!moduleIds.includes(id)) {
            throw new Error(
              `Intent-state source returned unexpected module id "${id}"`,
            )
          }
        }
        nextIntent = Object.freeze(
          intent.map((value) => Object.freeze({ ...value })),
        )
      } catch (error) {
        if (this.disposed) return
        errors.intent = errorMessage(error)
      }
    }

    if (generation !== this.refreshGeneration) return
    if (nextIntent) this.intent = nextIntent
    this.publish(
      Object.keys(errors).length === 0 ? 'ready' : 'error',
      buildRecords(
        this.catalog,
        this.installed,
        this.intent,
        this.options.getModuleFailure
          ? (moduleId) => this.options.getModuleFailure?.(moduleId)
          : undefined,
      ),
      Object.freeze(errors),
    )
  }

  private publish(
    status: ModuleManagerSnapshot['status'],
    modules: ReadonlyArray<ModuleRecord>,
    errors: ModuleManagerSnapshot['errors'],
  ): void {
    const error = [errors.catalog, errors.installed, errors.intent]
      .filter((message): message is string => Boolean(message))
      .join('; ')
    this.snapshot = Object.freeze({
      status,
      modules,
      errors,
      ...(error ? { error } : {}),
    })
    for (const listener of [...this.listeners]) listener()
  }
}
