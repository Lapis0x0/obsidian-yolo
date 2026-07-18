import type {
  InstalledModuleState,
  InstalledModuleStateSource,
  ModuleCatalogEntry,
  ModuleCatalogSource,
  ModuleManagerSnapshot,
  ModuleRecord,
  ModuleStatus,
} from './types'

export type ModuleManagerOptions = {
  catalogSource: ModuleCatalogSource
  installedStateSource: InstalledModuleStateSource
}

const EMPTY_ERRORS = Object.freeze({})
const EMPTY_MODULES = Object.freeze([]) as ReadonlyArray<ModuleRecord>
const EMPTY_CATALOG = Object.freeze([]) as ReadonlyArray<ModuleCatalogEntry>
const EMPTY_INSTALLED = Object.freeze([]) as ReadonlyArray<InstalledModuleState>
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

type ParsedVersion = {
  core: string[]
  prerelease: string[] | null
}

function compareNumericIdentifiers(left: string, right: string): number {
  const normalizedLeft = left.replace(/^0+(?=\d)/, '')
  const normalizedRight = right.replace(/^0+(?=\d)/, '')
  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length < normalizedRight.length ? -1 : 1
  }
  if (normalizedLeft === normalizedRight) return 0
  return normalizedLeft < normalizedRight ? -1 : 1
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value
    .trim()
    .match(
      /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    )
  if (!match) return null
  return {
    core: (match[1] ?? '').split('.'),
    prerelease: match[2] ? match[2].split('.') : null,
  }
}

function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  if (!leftVersion || !rightVersion) {
    return left === right ? 0 : left < right ? -1 : 1
  }

  const coreLength = Math.max(leftVersion.core.length, rightVersion.core.length)
  for (let index = 0; index < coreLength; index += 1) {
    const comparison = compareNumericIdentifiers(
      leftVersion.core[index] ?? '0',
      rightVersion.core[index] ?? '0',
    )
    if (comparison !== 0) return comparison
  }

  if (!leftVersion.prerelease && !rightVersion.prerelease) return 0
  if (!leftVersion.prerelease) return 1
  if (!rightVersion.prerelease) return -1

  const prereleaseLength = Math.max(
    leftVersion.prerelease.length,
    rightVersion.prerelease.length,
  )
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = leftVersion.prerelease[index]
    const rightPart = rightVersion.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    if (leftPart === rightPart) continue
    const leftIsNumeric = /^\d+$/.test(leftPart)
    const rightIsNumeric = /^\d+$/.test(rightPart)
    if (leftIsNumeric && rightIsNumeric) {
      return compareNumericIdentifiers(leftPart, rightPart)
    }
    if (leftIsNumeric) return -1
    if (rightIsNumeric) return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function resolveStatus(
  catalog: ModuleCatalogEntry | undefined,
  installed: InstalledModuleState | undefined,
): ModuleStatus {
  if (!installed) return 'available'
  if (installed.error) return 'failed'
  if (installed.disabled) return 'disabled'
  if (catalog && compareVersions(installed.version, catalog.version) < 0) {
    return 'update-available'
  }
  if (installed.active) return 'active'
  return 'installed'
}

function buildRecords(
  catalogValues: ReadonlyArray<ModuleCatalogEntry>,
  installedValues: ReadonlyArray<InstalledModuleState>,
): ReadonlyArray<ModuleRecord> {
  const catalogById = indexById(catalogValues, 'Catalog source')
  const installedById = indexById(installedValues, 'Installed-state source')
  const ids = new Set([...catalogById.keys(), ...installedById.keys()])
  return Object.freeze(
    [...ids].sort().map((id) => {
      const catalogValue = catalogById.get(id)
      const installedValue = installedById.get(id)
      const catalog = catalogValue
        ? Object.freeze({ ...catalogValue })
        : undefined
      const installed = installedValue
        ? Object.freeze({ ...installedValue })
        : undefined
      return Object.freeze({
        id,
        name: catalog?.name ?? id,
        description: catalog?.description ?? '',
        version: installed?.version ?? catalog?.version ?? '',
        ...(catalog &&
        installed &&
        compareVersions(installed.version, catalog.version) < 0
          ? { availableVersion: catalog.version }
          : {}),
        ...(installed?.error ? { error: installed.error } : {}),
        status: resolveStatus(catalog, installed),
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
    this.snapshot = INITIAL_SNAPSHOT
  }

  private async refreshOnce(generation: number): Promise<void> {
    if (this.disposed) return
    const [catalogResult, installedResult] = await Promise.allSettled([
      this.options.catalogSource.load(),
      this.options.installedStateSource.load(),
    ])
    if (this.disposed) return

    const errors: { catalog?: string; installed?: string } = {}
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

    if (generation !== this.refreshGeneration) return
    this.publish(
      Object.keys(errors).length === 0 ? 'ready' : 'error',
      buildRecords(this.catalog, this.installed),
      Object.freeze(errors),
    )
  }

  private publish(
    status: ModuleManagerSnapshot['status'],
    modules: ReadonlyArray<ModuleRecord>,
    errors: ModuleManagerSnapshot['errors'],
  ): void {
    const error = [errors.catalog, errors.installed]
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
