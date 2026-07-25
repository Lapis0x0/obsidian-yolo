export type ModuleFailureKind =
  | 'download-timeout'
  | 'download'
  | 'integrity'
  | 'activation'
  | 'unknown'

export type ModuleFailure = Readonly<{
  kind: ModuleFailureKind
  detail: string
}>

export type ModuleDownloadAttemptFailure = Readonly<{
  source: string
  error: string
}>

export class ModuleArtifactDownloadError extends Error {
  readonly kind: Extract<
    ModuleFailureKind,
    'download-timeout' | 'download' | 'integrity'
  >
  readonly attempts: readonly ModuleDownloadAttemptFailure[]

  constructor(
    label: string,
    attempts: readonly ModuleDownloadAttemptFailure[],
  ) {
    const snapshot = Object.freeze(
      attempts.map((attempt) => Object.freeze({ ...attempt })),
    )
    super(
      `${label} download failed from all official sources: ${snapshot
        .map(({ source, error }) => `${source}: ${error}`)
        .join('; ')}`,
    )
    this.name = 'ModuleArtifactDownloadError'
    this.attempts = snapshot
    this.kind = snapshot.some(({ error }) => /SHA-256 mismatch/.test(error))
      ? 'integrity'
      : snapshot.length > 0 &&
          snapshot.every(({ error }) => /timed out/.test(error))
        ? 'download-timeout'
        : 'download'
  }
}

export function describeModuleFailure(error: unknown): ModuleFailure {
  if (error instanceof ModuleArtifactDownloadError) {
    return Object.freeze({ kind: error.kind, detail: error.message })
  }
  const detail = error instanceof Error ? error.message : String(error)
  return Object.freeze({
    kind: /activat(?:e|ion)|could not be activated/i.test(detail)
      ? 'activation'
      : 'unknown',
    detail,
  })
}
