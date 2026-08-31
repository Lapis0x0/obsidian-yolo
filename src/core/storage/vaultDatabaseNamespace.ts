import type { App } from 'obsidian'

/**
 * localStorage key that stores this vault's random device-local database
 * namespace identity. Obsidian's `loadLocalStorage`/`saveLocalStorage` are
 * per-vault, so the same key resolves to independent values in each vault —
 * this is what keeps IndexedDB databases for different vaults from
 * colliding on one device.
 *
 * Shared by every host-owned IndexedDB-backed store (module device-local
 * storage, the vector store, ...). Do not change this key: it would orphan
 * every existing per-vault database on the next load.
 */
export const VAULT_DATABASE_NAMESPACE_KEY =
  'yolo-module-device-local-database-namespace'

export type VaultDatabaseNamespaceAppStorage = Pick<
  App,
  'loadLocalStorage' | 'saveLocalStorage'
>

export type ResolveVaultDatabaseNamespaceIdOptions = Readonly<{
  /** Test-only override for the random id generator. */
  createNamespaceId?: () => string
}>

/**
 * Resolves this vault's stable random namespace id, generating and
 * persisting one on first use. Throws (rather than silently falling back)
 * when the stored value is malformed or local storage is inaccessible —
 * callers should surface this as "this storage backend is unavailable"
 * rather than risk two vaults sharing a database.
 */
export function resolveVaultDatabaseNamespaceId(
  app: VaultDatabaseNamespaceAppStorage,
  options: ResolveVaultDatabaseNamespaceIdOptions = {},
): string {
  let stored: unknown
  try {
    stored = app.loadLocalStorage(VAULT_DATABASE_NAMESPACE_KEY)
  } catch (error) {
    throw namespaceError('vault database namespace read failed', error)
  }
  if (stored !== null && stored !== undefined) {
    if (!isVaultDatabaseNamespaceId(stored)) {
      throw new Error('vault database namespace is malformed')
    }
    return stored
  }

  let namespaceId: string
  try {
    namespaceId = (
      options.createNamespaceId ?? createVaultDatabaseNamespaceId
    )()
  } catch (error) {
    throw namespaceError('vault database namespace generation failed', error)
  }
  if (!isVaultDatabaseNamespaceId(namespaceId)) {
    throw new Error('generated vault database namespace is malformed')
  }
  try {
    app.saveLocalStorage(VAULT_DATABASE_NAMESPACE_KEY, namespaceId)
  } catch (error) {
    throw namespaceError('vault database namespace write failed', error)
  }
  return namespaceId
}

export function isVaultDatabaseNamespaceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  )
}

export function createVaultDatabaseNamespaceId(): string {
  const cryptoApi = globalThis.crypto
  if (!cryptoApi?.getRandomValues) {
    throw new Error('secure randomness is unavailable')
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex
    .slice(6, 8)
    .join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`
}

function namespaceError(message: string, cause?: unknown): Error {
  const detail =
    cause instanceof Error && cause.message ? `: ${cause.message}` : ''
  return new Error(`${message}${detail}`)
}
