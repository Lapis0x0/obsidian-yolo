export class DatabaseException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseException'
  }
}

export class DatabaseNotInitializedException extends DatabaseException {
  constructor(message = 'Database not initialized') {
    super(message)
    this.name = 'DatabaseNotInitializedException'
  }
}

export class DuplicateTemplateException extends DatabaseException {
  constructor(templateName: string) {
    super(`Template with name "${templateName}" already exists`)
    this.name = 'DuplicateTemplateException'
  }
}

export class PGLiteAbortedException extends DatabaseException {
  constructor(message = 'PGLite aborted during runtime') {
    super(message)
    this.name = 'PGLiteAbortedException'
  }
}

/**
 * Raised when persisting the PGlite snapshot to the vault fails — typically
 * `dumpDataDir('gzip')` running out of memory on large vector libraries (see
 * issue #408). Swallowing this would let the index UI report 100% complete
 * while the database is, in fact, not flushed; surfacing it is what lets the
 * RAG run state move to `failed` and the user see actionable feedback.
 *
 * Classified as `permanent` for retry-policy purposes — retrying immediately
 * is unlikely to help (the snapshot is just as big), and we don't want to
 * thrash the user with auto-retries on an OOM condition.
 */
export class DatabaseSaveFailedError extends DatabaseException {
  readonly cause: unknown
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to save vector database snapshot: ${detail}`)
    this.name = 'DatabaseSaveFailedError'
    this.cause = cause
  }
}

/**
 * Raised when the host environment lacks the `Response` /
 * `DecompressionStream` Web APIs PGlite needs to load the vector extension —
 * typically a stale Obsidian installer build (see #270, #579). Without this
 * check, PGlite silently skips loading the extension and every later query
 * fails with an opaque `extension "vector" is not available`; this exception
 * lets the RAG index UI show clear, actionable copy instead.
 *
 * Classified as `permanent` for retry-policy purposes — retrying immediately
 * can't help, the environment is what it is until the user updates Obsidian.
 */
export class PgliteUnsupportedEnvironmentException extends DatabaseException {
  constructor(message: string) {
    super(message)
    this.name = 'PgliteUnsupportedEnvironmentException'
  }
}
