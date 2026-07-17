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
