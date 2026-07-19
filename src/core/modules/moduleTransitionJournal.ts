import { sha256Hex } from './moduleIntegrity'
import type { ModuleDataEnvelope } from './moduleSettingsStore'
import { assertModuleId, assertModulePathSegment } from './moduleStore'

export const MAX_MODULE_TRANSITION_SETTINGS_SNAPSHOT_BYTES = 256 * 1024

const MAX_SETTINGS_SNAPSHOT_DEPTH = 32
const MAX_SETTINGS_SNAPSHOT_NODES = 10_000
const SHA256 = /^[a-f0-9]{64}$/
const DANGEROUS_NAMES = new Set(['__proto__', 'prototype', 'constructor'])
const MANAGED_SETTINGS_ROOT_SUFFIX = '.yolo_json_db/module-settings'
const SETTINGS_SNAPSHOT_HASH_DOMAIN =
  'yolo.module-transition.settings-snapshot.v1\u0000'

export type ModuleTransitionPhase =
  | 'prepared'
  | 'settings-committed'
  | 'activation-started'
  | 'committed'
  | 'rollback-completed'

export type ModuleTransitionSettingsSnapshot =
  | Readonly<{ present: false; envelope: null }>
  | Readonly<{ present: true; envelope: ModuleDataEnvelope }>

export type ModuleTransitionSettingsLocation = Readonly<{
  moduleId: string
  storageRoot: string
  storagePath: string
}>

export type ModuleTransitionJournal = Readonly<{
  phase: ModuleTransitionPhase
  moduleId: string
  platform: 'desktop' | 'mobile'
  previousActiveVersion: string | null
  targetVersion: string
  targetManifestSha256: string
  settings: Readonly<{
    namespace: 'settings'
    location: ModuleTransitionSettingsLocation
    sourceSchemaVersion: number
    targetSchemaVersion: number
    previous: ModuleTransitionSettingsSnapshot
    previousSha256: string
    expectedPostSha256: string
  }> | null
}>

declare const SNAPSHOT_VERIFIED_MODULE_TRANSITION_JOURNAL: unique symbol

export type SnapshotVerifiedModuleTransitionJournal = ModuleTransitionJournal &
  Readonly<{ [SNAPSHOT_VERIFIED_MODULE_TRANSITION_JOURNAL]: true }>

export type ModuleTransitionJournalBinding = Readonly<{
  moduleId: string
  platform: 'desktop' | 'mobile'
  activeVersion: string | null
  downloadedCandidate: string | null
  pendingVersion: string | null
  readyVersions: readonly string[]
  targetDescriptor: Readonly<{
    manifest: Readonly<{ sha256: string }>
    dataSchemas: Readonly<
      Record<
        string,
        Readonly<{ readMin: number; readMax: number; write: number }>
      >
    >
  }> | null
}>

/** Validates and freezes structure and state bindings without checking content hashes. */
export function parseModuleTransitionJournal(
  value: unknown,
  binding: ModuleTransitionJournalBinding,
): ModuleTransitionJournal {
  const journal = plainRecord(value, 'Module transition journal')
  assertExactKeys(journal, [
    'phase',
    'moduleId',
    'platform',
    'previousActiveVersion',
    'targetVersion',
    'targetManifestSha256',
    'settings',
  ])

  const phase = dataProperty(journal, 'phase')
  const moduleId = dataProperty(journal, 'moduleId')
  const platform = dataProperty(journal, 'platform')
  const previousActiveVersion = dataProperty(journal, 'previousActiveVersion')
  const targetVersion = dataProperty(journal, 'targetVersion')
  const targetManifestSha256 = dataProperty(journal, 'targetManifestSha256')
  if (!isPhase(phase)) throw new Error('Transition phase is invalid')
  if (moduleId !== binding.moduleId) {
    throw new Error('Transition moduleId does not match device state')
  }
  if (platform !== 'desktop' && platform !== 'mobile') {
    throw new Error('Transition platform is invalid')
  }
  if (platform !== binding.platform) {
    throw new Error('Transition platform does not match device state')
  }
  if (
    previousActiveVersion !== null &&
    typeof previousActiveVersion !== 'string'
  ) {
    throw new Error('Transition previous active version is invalid')
  }
  if (typeof targetVersion !== 'string') {
    throw new Error('Transition target version is invalid')
  }
  if (!isSha256(targetManifestSha256)) {
    throw new Error('Transition target manifest SHA-256 is invalid')
  }
  if (!binding.targetDescriptor) {
    throw new Error('Transition target must refer to a ready version')
  }
  if (targetManifestSha256 !== binding.targetDescriptor.manifest.sha256) {
    throw new Error('Transition target manifest does not match its descriptor')
  }
  if (previousActiveVersion === targetVersion) {
    throw new Error(
      'Transition target must differ from previous active version',
    )
  }
  if (
    previousActiveVersion !== null &&
    !binding.readyVersions.includes(previousActiveVersion)
  ) {
    throw new Error('Transition previous active must refer to a ready version')
  }

  if (phase === 'committed') {
    if (
      binding.activeVersion !== targetVersion ||
      binding.downloadedCandidate !== null ||
      binding.pendingVersion !== null
    ) {
      throw new Error('Committed transition pointers are invalid')
    }
  } else if (phase === 'rollback-completed') {
    if (
      binding.activeVersion !== previousActiveVersion ||
      binding.downloadedCandidate !== targetVersion ||
      binding.pendingVersion !== null
    ) {
      throw new Error('Rollback-completed transition pointers are invalid')
    }
  } else if (
    binding.activeVersion !== previousActiveVersion ||
    binding.downloadedCandidate !== null ||
    binding.pendingVersion !== targetVersion
  ) {
    throw new Error('Uncommitted transition pointers are invalid')
  }

  const settings = parseSettings(
    dataProperty(journal, 'settings'),
    binding.targetDescriptor.dataSchemas.settings,
    moduleId,
  )
  return Object.freeze({
    phase,
    moduleId,
    platform,
    previousActiveVersion,
    targetVersion,
    targetManifestSha256,
    settings,
  })
}

/**
 * Parses and binds untrusted input before checking the domain-separated content
 * digest of the canonical previous-settings snapshot. This detects conflicts;
 * it does not authenticate the journal. Only this function creates the brand.
 */
export async function verifyModuleTransitionJournalSnapshot(
  value: unknown,
  binding: ModuleTransitionJournalBinding,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<SnapshotVerifiedModuleTransitionJournal> {
  const journal = parseModuleTransitionJournal(value, binding)
  if (journal.settings === null) {
    return journal as SnapshotVerifiedModuleTransitionJournal
  }
  const actual = await hashModuleTransitionSettingsSnapshot(
    journal.settings.previous,
    subtleCrypto,
  )
  if (actual !== journal.settings.previousSha256) {
    throw new Error('Transition previous settings SHA-256 mismatch')
  }
  return journal as SnapshotVerifiedModuleTransitionJournal
}

export function hashModuleTransitionSettingsSnapshot(
  snapshot: ModuleTransitionSettingsSnapshot,
  subtleCrypto: Pick<SubtleCrypto, 'digest'>,
): Promise<string> {
  // Domain-separated canonical content identity for conflict detection. This
  // digest does not authenticate the journal because no secret is involved.
  return sha256Hex(
    new TextEncoder().encode(
      `${SETTINGS_SNAPSHOT_HASH_DOMAIN}${canonicalJson(snapshot)}`,
    ),
    subtleCrypto,
  )
}

export function advanceModuleTransitionPhase(
  current: ModuleTransitionPhase,
  next: ModuleTransitionPhase,
): ModuleTransitionPhase {
  if (!isPhase(current) || !isPhase(next)) {
    throw new Error('Transition phase is invalid')
  }
  const allowed =
    (current === 'prepared' && next === 'settings-committed') ||
    (current === 'settings-committed' &&
      (next === 'activation-started' || next === 'rollback-completed')) ||
    (current === 'activation-started' &&
      (next === 'committed' || next === 'rollback-completed'))
  if (!allowed) {
    throw new Error('Transition phase advancement is invalid')
  }
  return next
}

function parseSettings(
  value: unknown,
  descriptorSchema:
    | Readonly<{ readMin: number; readMax: number; write: number }>
    | undefined,
  moduleId: string,
): ModuleTransitionJournal['settings'] {
  if (!descriptorSchema) {
    if (value !== null) {
      throw new Error('Stateless transition settings must be null')
    }
    return null
  }
  if (value === null) {
    return null
  }
  const settings = plainRecord(value, 'Transition settings')
  assertExactKeys(settings, [
    'namespace',
    'location',
    'sourceSchemaVersion',
    'targetSchemaVersion',
    'previous',
    'previousSha256',
    'expectedPostSha256',
  ])
  const namespace = dataProperty(settings, 'namespace')
  const sourceSchemaVersion = dataProperty(settings, 'sourceSchemaVersion')
  const targetSchemaVersion = dataProperty(settings, 'targetSchemaVersion')
  const previousSha256 = dataProperty(settings, 'previousSha256')
  const expectedPostSha256 = dataProperty(settings, 'expectedPostSha256')
  if (namespace !== 'settings') {
    throw new Error('Transition settings namespace is unsupported')
  }
  const location = parseModuleTransitionSettingsLocation(
    dataProperty(settings, 'location'),
    moduleId,
  )
  if (!isSchemaVersion(sourceSchemaVersion)) {
    throw new Error('Transition source settings schema is invalid')
  }
  if (!isSchemaVersion(targetSchemaVersion)) {
    throw new Error('Transition target settings schema is invalid')
  }
  if (!isSha256(previousSha256) || !isSha256(expectedPostSha256)) {
    throw new Error('Transition settings SHA-256 is invalid')
  }
  if (
    sourceSchemaVersion < descriptorSchema.readMin ||
    sourceSchemaVersion > descriptorSchema.readMax ||
    targetSchemaVersion !== descriptorSchema.write ||
    sourceSchemaVersion !== targetSchemaVersion
  ) {
    throw new Error(
      'Transition settings schemas do not match the target descriptor',
    )
  }

  const previous = parsePreviousSettings(
    dataProperty(settings, 'previous'),
    sourceSchemaVersion,
  )
  return Object.freeze({
    namespace,
    location,
    sourceSchemaVersion,
    targetSchemaVersion,
    previous,
    previousSha256,
    expectedPostSha256,
  })
}

export function parseModuleTransitionSettingsLocation(
  value: unknown,
  expectedModuleId?: string,
): ModuleTransitionSettingsLocation {
  const location = plainRecord(value, 'Transition settings location')
  assertExactKeys(location, ['moduleId', 'storageRoot', 'storagePath'])
  const moduleId = dataProperty(location, 'moduleId')
  const storageRoot = dataProperty(location, 'storageRoot')
  const storagePath = dataProperty(location, 'storagePath')
  if (typeof moduleId !== 'string') {
    throw new Error('Transition settings location moduleId is invalid')
  }
  assertModuleId(moduleId, 'Transition settings location moduleId')
  if (expectedModuleId !== undefined && moduleId !== expectedModuleId) {
    throw new Error(
      'Transition settings location moduleId does not match journal',
    )
  }
  if (
    typeof storageRoot !== 'string' ||
    !isSafeVaultRelativePath(storageRoot)
  ) {
    throw new Error('Transition settings storage root is invalid')
  }
  const expectedPath = `${storageRoot}/${moduleId}.json`
  if (typeof storagePath !== 'string' || storagePath !== expectedPath) {
    throw new Error('Transition settings storage path is invalid')
  }
  return Object.freeze({ moduleId, storageRoot, storagePath })
}

function parsePreviousSettings(
  value: unknown,
  sourceSchemaVersion: number,
): ModuleTransitionSettingsSnapshot {
  const previous = plainRecord(value, 'Previous settings snapshot')
  assertExactKeys(previous, ['present', 'envelope'])
  const present = dataProperty(previous, 'present')
  const envelopeValue = dataProperty(previous, 'envelope')
  if (present === false) {
    if (envelopeValue !== null) {
      throw new Error('Absent previous settings must have a null envelope')
    }
    if (sourceSchemaVersion !== 0) {
      throw new Error('Absent previous settings must use source schema 0')
    }
    return Object.freeze({ present: false, envelope: null })
  }
  if (present !== true) throw new Error('Previous settings presence is invalid')

  const envelope = plainRecord(envelopeValue, 'Previous settings envelope')
  assertExactKeys(envelope, ['schemaVersion', 'data'])
  const schemaVersion = dataProperty(envelope, 'schemaVersion')
  if (
    !isSchemaVersion(schemaVersion) ||
    schemaVersion !== sourceSchemaVersion
  ) {
    throw new Error('Previous settings envelope schema is invalid')
  }
  const budget = { nodes: 0 }
  const data = canonicalJsonSnapshot(dataProperty(envelope, 'data'), 0, budget)
  const snapshotEnvelope = Object.freeze({ schemaVersion, data })
  if (
    utf8ByteLength(canonicalJson(snapshotEnvelope)) >
    MAX_MODULE_TRANSITION_SETTINGS_SNAPSHOT_BYTES
  ) {
    throw new Error('Previous settings snapshot is too large')
  }
  return Object.freeze({ present: true, envelope: snapshotEnvelope })
}

function canonicalJsonSnapshot(
  value: unknown,
  depth: number,
  budget: { nodes: number },
): unknown {
  budget.nodes += 1
  if (
    depth > MAX_SETTINGS_SNAPSHOT_DEPTH ||
    budget.nodes > MAX_SETTINGS_SNAPSHOT_NODES
  ) {
    throw new Error('Previous settings snapshot is too complex')
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Previous settings snapshot numbers must be finite')
    }
    return value
  }
  if (typeof value !== 'object') {
    throw new TypeError(
      'Previous settings snapshot must contain only JSON values',
    )
  }
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new TypeError('Previous settings arrays must be plain')
    }
    const names = Object.getOwnPropertyNames(value)
    if (names.length !== value.length + 1 || !names.includes('length')) {
      throw new TypeError('Previous settings arrays must be dense data arrays')
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!names.includes(String(index))) {
        throw new TypeError(
          'Previous settings arrays must be dense data arrays',
        )
      }
    }
    return Object.freeze(
      Array.from({ length: value.length }, (_, index) =>
        canonicalJsonSnapshot(
          dataProperty(value, String(index)),
          depth + 1,
          budget,
        ),
      ),
    )
  }

  const record = plainRecord(value, 'Previous settings object')
  const result: Record<string, unknown> = {}
  for (const name of Object.getOwnPropertyNames(record).sort()) {
    assertSafeName(name, 'Previous settings property')
    result[name] = canonicalJsonSnapshot(
      dataProperty(record, name),
      depth + 1,
      budget,
    )
  }
  return Object.freeze(result)
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    throw new TypeError(`${label} must be a plain object`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const names = Object.getOwnPropertyNames(value)
  for (const name of names) assertSafeName(name, 'Property')
  if (
    names.length !== expected.length ||
    expected.some((name) => !names.includes(name))
  ) {
    throw new Error(`Object must contain only ${expected.join(', ')}`)
  }
  for (const name of names) dataProperty(value, name)
}

function dataProperty(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw new TypeError(
      `Property "${name}" must be an enumerable data property`,
    )
  }
  return descriptor.value
}

function assertSafeName(value: string, label: string): void {
  if (DANGEROUS_NAMES.has(value)) throw new Error(`${label} is forbidden`)
}

function isSchemaVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value)
}

function isPhase(value: unknown): value is ModuleTransitionPhase {
  return (
    value === 'prepared' ||
    value === 'settings-committed' ||
    value === 'activation-started' ||
    value === 'committed' ||
    value === 'rollback-completed'
  )
}

function isSafeVaultRelativePath(value: string): boolean {
  if (
    !(
      value.length > 0 &&
      value.normalize('NFC') === value &&
      !value.includes('\\') &&
      !value.startsWith('/') &&
      !value.endsWith('/') &&
      !/^[A-Za-z]:\//.test(value)
    )
  ) {
    return false
  }
  try {
    const parts = value.split('/')
    if (
      parts.length < 3 ||
      parts.slice(-2).join('/') !== MANAGED_SETTINGS_ROOT_SUFFIX
    ) {
      return false
    }
    for (const part of parts) {
      if (!part || part === '.' || part === '..') return false
      assertModulePathSegment(
        part.startsWith('.') ? `root${part}` : part,
        'Transition settings storage root',
      )
    }
    return true
  } catch {
    return false
  }
}
