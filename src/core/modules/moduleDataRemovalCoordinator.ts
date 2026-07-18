import { assertManagedModuleDataNamespace } from './managedModuleDataLock'
import type { ModuleIntentStore } from './moduleIntentStore'
import type { ModuleRuntimeQuiescence } from './moduleRuntimeReservation'
import { assertModuleId, assertModulePathSegment } from './moduleStore'

const MAX_DESCRIPTORS = 256
const MAX_PATH_LENGTH = 1024
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type ModuleConfigDocumentDataDescriptor = Readonly<{
  kind: 'config-document'
  moduleId: string
  documentId: string
  path: string
  deletion: 'exact'
}>

export type ModulePrivateNamespaceDataDescriptor = Readonly<{
  kind: 'module-private-namespace'
  moduleId: string
  locality: 'synchronized' | 'device-local'
  namespace: string
  deletion: 'exact'
}>

export type LearningCanonicalContentDataDescriptor = Readonly<{
  kind: 'learning-canonical-content'
  moduleId: 'learning'
  projectSlug: string
  /** Exact canonical project root; trash is the only recoverable boundary. */
  path: string
  deletion: 'trash'
}>

export type LearningSrsDataDescriptor = Readonly<{
  kind: 'learning-srs'
  moduleId: 'learning'
  projectSlug: string
  /** Exact sidecar file; unlike canonical content, this is not trash-recoverable. */
  path: string
  deletion: 'exact'
}>

export type LearningImportJournalDataDescriptor = Readonly<{
  kind: 'learning-import-journal'
  moduleId: 'learning'
  journalId: string
  path: string
  deletion: 'exact'
}>

/** The complete, closed set of data classes eligible for destructive removal. */
export type ModuleOwnedDataDescriptor =
  | ModuleConfigDocumentDataDescriptor
  | ModulePrivateNamespaceDataDescriptor
  | LearningCanonicalContentDataDescriptor
  | LearningSrsDataDescriptor
  | LearningImportJournalDataDescriptor

export type ModuleDataRemovalAuthorizationRequest = Readonly<{
  moduleId: string
  descriptors: readonly ModuleOwnedDataDescriptor[]
  completedDescriptorIds: readonly string[]
}>

export type ModuleDataRemovalAuthorizationPort = Readonly<{
  /** Verifies a product-issued, short-lived token bound to this exact request. */
  verifyHighRiskToken(
    token: unknown,
    request: ModuleDataRemovalAuthorizationRequest,
  ): Promise<boolean>
}>

export type ModuleDataOwnershipPort = Readonly<{
  /** Host policy must independently bind the descriptor to the named module. */
  approve(
    moduleId: string,
    descriptor: ModuleOwnedDataDescriptor,
  ): Promise<boolean>
}>

export type ModuleOwnedDataRemovalPort = Readonly<{
  /**
   * Must be idempotent. `trash` moves canonical content through the Vault trash
   * API; `exact` removes only the addressed document or namespace.
   */
  remove(descriptor: ModuleOwnedDataDescriptor): Promise<void>
}>

export type ModuleDataRemovalJournal = Readonly<{
  version: 1
  moduleId: string
  planKey: string
  descriptors: readonly ModuleOwnedDataDescriptor[]
  completedDescriptorIds: readonly string[]
}>

export type ModuleDataRemovalJournalPort = Readonly<{
  read(moduleId: string): Promise<unknown>
  write(moduleId: string, journal: ModuleDataRemovalJournal): Promise<void>
  remove(moduleId: string): Promise<void>
}>

export type ModuleDataRemovalCoordinatorOptions = Readonly<{
  /** Existing ordinary uninstall; it removes program artifacts, never user data. */
  artifactUninstaller: Readonly<{ uninstall(moduleId: string): Promise<void> }>
  runtime: ModuleRuntimeQuiescence
  intentStore: Pick<ModuleIntentStore, 'get'>
  ownership: ModuleDataOwnershipPort
  authorization: ModuleDataRemovalAuthorizationPort
  removal: ModuleOwnedDataRemovalPort
  journal: ModuleDataRemovalJournalPort
}>

export type ModuleDataRemovalResult = Readonly<{
  removedDescriptorIds: readonly string[]
  resumedDescriptorIds: readonly string[]
}>

/**
 * Explicit high-risk path for uninstalling a module and then deleting its data.
 * Construction has no side effects and ordinary uninstall never calls this path.
 */
export class ModuleDataRemovalCoordinator {
  constructor(private readonly options: ModuleDataRemovalCoordinatorOptions) {
    if (
      !options ||
      typeof options.artifactUninstaller?.uninstall !== 'function' ||
      typeof options.runtime?.runWithModuleQuiesced !== 'function' ||
      typeof options.intentStore?.get !== 'function' ||
      typeof options.ownership?.approve !== 'function' ||
      typeof options.authorization?.verifyHighRiskToken !== 'function' ||
      typeof options.removal?.remove !== 'function' ||
      typeof options.journal?.read !== 'function' ||
      typeof options.journal?.write !== 'function' ||
      typeof options.journal?.remove !== 'function'
    ) {
      throw new Error('Module data removal coordinator options are invalid')
    }
  }

  async uninstallAndRemoveData(
    moduleId: string,
    descriptors: readonly ModuleOwnedDataDescriptor[],
    authorizationToken: unknown,
  ): Promise<ModuleDataRemovalResult> {
    assertModuleId(moduleId, 'Module id')
    const plan = parseAndOrderPlan(moduleId, descriptors)

    // Program artifacts must be fully uninstalled before this independent data
    // deletion path can ask for its separate high-risk authorization.
    await this.options.artifactUninstaller.uninstall(moduleId)

    return this.options.runtime.runWithModuleQuiesced(moduleId, async () => {
      const intent = await this.options.intentStore.get(moduleId)
      if (intent?.desiredInstalled !== false) {
        throw new Error(
          `Module "${moduleId}" data removal requires desiredInstalled to be false`,
        )
      }

      for (const entry of plan.entries) {
        if (
          (await this.options.ownership.approve(moduleId, entry.value)) !== true
        ) {
          throw new Error(
            `Module "${moduleId}" data descriptor is not approved by Host ownership policy`,
          )
        }
      }

      const stored = await this.options.journal.read(moduleId)
      const journal = parseRemovalJournal(stored, moduleId, plan)
      const completed = new Set(journal?.completedDescriptorIds ?? [])
      const request = Object.freeze({
        moduleId,
        descriptors: Object.freeze(plan.entries.map((entry) => entry.value)),
        completedDescriptorIds: Object.freeze(
          plan.entries
            .map((entry) => entry.id)
            .filter((id) => completed.has(id)),
        ),
      })
      if (
        authorizationToken === null ||
        authorizationToken === undefined ||
        (await this.options.authorization.verifyHighRiskToken(
          authorizationToken,
          request,
        )) !== true
      ) {
        throw new Error(
          `Module "${moduleId}" data removal requires an independent high-risk authorization token`,
        )
      }

      await this.options.journal.write(moduleId, createJournal(plan, completed))
      const resumedDescriptorIds = Object.freeze([...completed])
      const removedDescriptorIds: string[] = []
      for (const entry of plan.entries) {
        if (completed.has(entry.id)) continue
        await this.options.removal.remove(entry.value)
        completed.add(entry.id)
        removedDescriptorIds.push(entry.id)
        await this.options.journal.write(
          moduleId,
          createJournal(plan, completed),
        )
      }
      await this.options.journal.remove(moduleId)
      return Object.freeze({
        removedDescriptorIds: Object.freeze(removedDescriptorIds),
        resumedDescriptorIds,
      })
    })
  }
}

type PlanEntry = Readonly<{ id: string; value: ModuleOwnedDataDescriptor }>
type RemovalPlan = Readonly<{
  key: string
  entries: readonly PlanEntry[]
  ids: ReadonlySet<string>
}>

function parseAndOrderPlan(
  moduleId: string,
  descriptors: readonly ModuleOwnedDataDescriptor[],
): RemovalPlan {
  const descriptorInputs = plainDataArray(
    descriptors,
    'Module data removal descriptors',
  )
  if (descriptorInputs.length === 0) {
    throw new Error('Module data removal requires explicit descriptors')
  }
  if (descriptorInputs.length > MAX_DESCRIPTORS) {
    throw new Error('Module data removal descriptor limit exceeded')
  }
  const entries = descriptorInputs.map((descriptor) => {
    const value = parseDescriptor(descriptor, moduleId)
    return Object.freeze({ id: descriptorId(value), value })
  })
  entries.sort(compareEntries)
  const ids = new Set(entries.map((entry) => entry.id))
  const canonicalIds = new Set(
    entries.map((entry) => entry.id.normalize('NFKC').toLowerCase()),
  )
  const targets = new Set(
    entries.map((entry) => descriptorTargetIdentity(entry.value)),
  )
  if (
    ids.size !== entries.length ||
    canonicalIds.size !== entries.length ||
    targets.size !== entries.length
  ) {
    throw new Error('Module data removal descriptors must be unique')
  }
  const frozenEntries = Object.freeze(entries)
  return Object.freeze({
    key: JSON.stringify(frozenEntries.map((entry) => entry.value)),
    entries: frozenEntries,
    ids,
  })
}

function parseDescriptor(
  input: unknown,
  expectedModuleId: string,
): ModuleOwnedDataDescriptor {
  const value = plainRecord(input, 'Module data descriptor')
  const kind = dataProperty(value, 'kind')
  const moduleId = dataProperty(value, 'moduleId')
  if (typeof moduleId !== 'string')
    throw new Error('Descriptor moduleId is invalid')
  assertModuleId(moduleId, 'Descriptor module id')
  if (moduleId !== expectedModuleId) {
    throw new Error('Module data descriptor ownership does not match module')
  }

  if (kind === 'config-document') return parseConfigDescriptor(value, moduleId)
  if (kind === 'module-private-namespace') {
    return parsePrivateDescriptor(value, moduleId)
  }
  if (moduleId !== 'learning') {
    throw new Error('Learning data descriptors belong only to learning')
  }
  if (kind === 'learning-canonical-content') {
    return parseLearningContentDescriptor(value)
  }
  if (kind === 'learning-srs') return parseLearningSrsDescriptor(value)
  if (kind === 'learning-import-journal') {
    return parseLearningJournalDescriptor(value)
  }
  throw new Error('Module data descriptor kind is unsupported')
}

function parseConfigDescriptor(
  value: Record<string, unknown>,
  moduleId: string,
): ModuleConfigDocumentDataDescriptor {
  assertExactKeys(value, ['kind', 'moduleId', 'documentId', 'path', 'deletion'])
  const documentId = requiredSegment(value, 'documentId', 'Config document id')
  const path = requiredSafePath(value, 'path')
  if (
    dataProperty(value, 'deletion') !== 'exact' ||
    !hasManagedSuffix(path, ['module-settings', `${moduleId}.json`])
  ) {
    throw new Error(
      'Config document descriptor must address an exact managed document',
    )
  }
  return Object.freeze({
    kind: 'config-document',
    moduleId,
    documentId,
    path,
    deletion: 'exact',
  })
}

function parsePrivateDescriptor(
  value: Record<string, unknown>,
  moduleId: string,
): ModulePrivateNamespaceDataDescriptor {
  assertExactKeys(value, [
    'kind',
    'moduleId',
    'locality',
    'namespace',
    'deletion',
  ])
  const locality = dataProperty(value, 'locality')
  const namespace = dataProperty(value, 'namespace')
  if (locality !== 'synchronized' && locality !== 'device-local') {
    throw new Error('Module private namespace locality is invalid')
  }
  if (typeof namespace !== 'string') {
    throw new Error('Module private namespace is invalid')
  }
  assertManagedModuleDataNamespace(namespace)
  if (dataProperty(value, 'deletion') !== 'exact') {
    throw new Error('Module private namespace deletion must be exact')
  }
  return Object.freeze({
    kind: 'module-private-namespace',
    moduleId,
    locality,
    namespace,
    deletion: 'exact',
  })
}

function parseLearningContentDescriptor(
  value: Record<string, unknown>,
): LearningCanonicalContentDataDescriptor {
  assertExactKeys(value, [
    'kind',
    'moduleId',
    'projectSlug',
    'path',
    'deletion',
  ])
  const projectSlug = requiredProjectSlug(value)
  const path = requiredSafePath(value, 'path')
  const parts = path.split('/')
  if (
    dataProperty(value, 'deletion') !== 'trash' ||
    parts.length < 3 ||
    parts.at(-2) !== 'learning' ||
    parts.at(-1) !== projectSlug
  ) {
    throw new Error(
      'Learning canonical content must be an explicit project root removed through trash',
    )
  }
  return Object.freeze({
    kind: 'learning-canonical-content',
    moduleId: 'learning',
    projectSlug,
    path,
    deletion: 'trash',
  })
}

function parseLearningSrsDescriptor(
  value: Record<string, unknown>,
): LearningSrsDataDescriptor {
  assertExactKeys(value, [
    'kind',
    'moduleId',
    'projectSlug',
    'path',
    'deletion',
  ])
  const projectSlug = requiredProjectSlug(value)
  const path = requiredSafePath(value, 'path')
  if (
    dataProperty(value, 'deletion') !== 'exact' ||
    !hasManagedSuffix(path, ['learning-srs', `${projectSlug}.json`])
  ) {
    throw new Error(
      'Learning SRS descriptor must address exact managed project state',
    )
  }
  return Object.freeze({
    kind: 'learning-srs',
    moduleId: 'learning',
    projectSlug,
    path,
    deletion: 'exact',
  })
}

function parseLearningJournalDescriptor(
  value: Record<string, unknown>,
): LearningImportJournalDataDescriptor {
  assertExactKeys(value, ['kind', 'moduleId', 'journalId', 'path', 'deletion'])
  const journalId = dataProperty(value, 'journalId')
  if (typeof journalId !== 'string' || !UUID.test(journalId)) {
    throw new Error('Learning import journal id is invalid')
  }
  const path = requiredSafePath(value, 'path')
  if (
    dataProperty(value, 'deletion') !== 'exact' ||
    !hasManagedSuffix(path, ['anki-import-journals', `${journalId}.json`])
  ) {
    throw new Error(
      'Learning import journal descriptor must address an exact journal',
    )
  }
  return Object.freeze({
    kind: 'learning-import-journal',
    moduleId: 'learning',
    journalId,
    path,
    deletion: 'exact',
  })
}

function parseRemovalJournal(
  input: unknown,
  moduleId: string,
  plan: RemovalPlan,
): ModuleDataRemovalJournal | null {
  if (input === null) return null
  const value = plainRecord(input, 'Module data removal journal')
  assertExactKeys(value, [
    'version',
    'moduleId',
    'planKey',
    'descriptors',
    'completedDescriptorIds',
  ])
  if (
    dataProperty(value, 'version') !== 1 ||
    dataProperty(value, 'moduleId') !== moduleId ||
    dataProperty(value, 'planKey') !== plan.key
  ) {
    throw new Error(
      'Module data removal journal does not match the requested plan',
    )
  }
  const completed = plainDataArray(
    dataProperty(value, 'completedDescriptorIds'),
    'Module data removal journal completion list',
  )
  const descriptors = plainDataArray(
    dataProperty(value, 'descriptors'),
    'Module data removal journal descriptors',
  ).map((descriptor) => parseDescriptor(descriptor, moduleId))
  if (JSON.stringify(descriptors) !== plan.key) {
    throw new Error(
      'Module data removal journal descriptors do not match the requested plan',
    )
  }
  const ids = completed.map((id) => {
    if (typeof id !== 'string' || !plan.ids.has(id)) {
      throw new Error(
        'Module data removal journal contains an unknown descriptor',
      )
    }
    return id
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      'Module data removal journal contains duplicate descriptors',
    )
  }
  return Object.freeze({
    version: 1,
    moduleId,
    planKey: plan.key,
    descriptors: Object.freeze(descriptors),
    completedDescriptorIds: Object.freeze(ids),
  })
}

function createJournal(
  plan: RemovalPlan,
  completed: ReadonlySet<string>,
): ModuleDataRemovalJournal {
  const moduleId = plan.entries[0].value.moduleId
  return Object.freeze({
    version: 1,
    moduleId,
    planKey: plan.key,
    descriptors: Object.freeze(plan.entries.map((entry) => entry.value)),
    completedDescriptorIds: Object.freeze(
      plan.entries.map((entry) => entry.id).filter((id) => completed.has(id)),
    ),
  })
}

function descriptorId(value: ModuleOwnedDataDescriptor): string {
  switch (value.kind) {
    case 'config-document':
      return `config:${value.documentId}:${value.path}`
    case 'module-private-namespace':
      return `private:${value.locality}:${value.namespace}`
    case 'learning-canonical-content':
      return `learning-content:${value.projectSlug}:${value.path}`
    case 'learning-srs':
      return `learning-srs:${value.projectSlug}:${value.path}`
    case 'learning-import-journal':
      return `learning-journal:${value.journalId}:${value.path}`
  }
}

function descriptorTargetIdentity(value: ModuleOwnedDataDescriptor): string {
  switch (value.kind) {
    case 'config-document':
    case 'learning-canonical-content':
    case 'learning-srs':
    case 'learning-import-journal':
      return `path:${value.path.normalize('NFKC').toLowerCase()}`
    case 'module-private-namespace':
      return `private:${value.locality}:${value.namespace}`
  }
}

function compareEntries(left: PlanEntry, right: PlanEntry): number {
  return (
    removalRank(left.value) - removalRank(right.value) ||
    left.id.localeCompare(right.id)
  )
}

function removalRank(value: ModuleOwnedDataDescriptor): number {
  switch (value.kind) {
    case 'learning-canonical-content':
      return 0
    case 'learning-srs':
      return 1
    case 'learning-import-journal':
      return 2
    case 'config-document':
      return 3
    case 'module-private-namespace':
      return 4
  }
}

function requiredProjectSlug(value: Record<string, unknown>): string {
  const slug = dataProperty(value, 'projectSlug')
  if (typeof slug !== 'string') {
    throw new Error('Learning project slug is invalid')
  }
  assertModulePathSegment(slug, 'Learning project slug')
  return slug
}

function requiredSegment(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const segment = dataProperty(value, key)
  if (typeof segment !== 'string') throw new Error(`${label} is invalid`)
  assertModulePathSegment(segment, label)
  if (segment !== segment.toLowerCase()) {
    throw new Error(`${label} must be lowercase`)
  }
  return segment
}

function requiredSafePath(value: Record<string, unknown>, key: string): string {
  const path = dataProperty(value, key)
  if (typeof path !== 'string' || !isSafeVaultPath(path)) {
    throw new Error('Module data descriptor path is unsafe')
  }
  return path
}

function isSafeVaultPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_PATH_LENGTH &&
    path.normalize('NFC') === path &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !/^[A-Za-z]:\//.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  )
}

function hasManagedSuffix(path: string, suffix: readonly string[]): boolean {
  const parts = path.split('/')
  if (parts.length < suffix.length + 1) return false
  const databaseRoot = parts.at(-(suffix.length + 1))
  return (
    (databaseRoot === '.yolo_json_db' || databaseRoot === '.smtcmp_json_db') &&
    suffix.every(
      (part, index) => parts[parts.length - suffix.length + index] === part,
    )
  )
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function plainDataArray<T>(value: readonly T[], label: string): readonly T[]
function plainDataArray(value: unknown, label: string): readonly unknown[]
function plainDataArray(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    throw new TypeError(`${label} must be a plain array`)
  }
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length')) {
    throw new TypeError(`${label} must be a dense data array`)
  }
  const result: unknown[] = []
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index)
    if (!names.includes(key)) {
      throw new TypeError(`${label} must be a dense data array`)
    }
    result.push(dataProperty(value, key))
  }
  return result
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.getOwnPropertyNames(value)
  if (
    actual.length !== expected.length ||
    expected.some((key) => !actual.includes(key))
  ) {
    throw new Error(`Descriptor must contain only ${expected.join(', ')}`)
  }
  for (const key of actual) dataProperty(value, key)
}

function dataProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor?.enumerable || !('value' in descriptor)) {
    throw new TypeError(`Property "${key}" must be an enumerable data property`)
  }
  return descriptor.value
}
