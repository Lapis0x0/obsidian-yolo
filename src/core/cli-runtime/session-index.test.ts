import {
  CLI_SESSION_INDEX_SCHEMA_VERSION,
  cliSessionIndexDocumentSchema,
  createCliSessionIndexEntry,
  getCliSessionIndexKey,
  toCliSessionRef,
} from './session-index'

describe('CLI session index contract', () => {
  it('uses runtime and native session id as the stable identity', () => {
    expect(
      getCliSessionIndexKey({
        runtimeId: 'codex',
        nativeSessionId: 'thread/with spaces',
      }),
    ).toBe('codex:thread%2Fwith%20spaces')
  })

  it('keeps paths as mutable hints outside the stable key', () => {
    const entry = createCliSessionIndexEntry({
      runtimeId: 'claude-code',
      nativeSessionId: 'session-1',
      sessionPathHint: '/old/path.jsonl',
      modelId: 'sonnet',
    })

    expect(getCliSessionIndexKey(entry)).toBe('claude-code:session-1')
    expect(toCliSessionRef(entry)).toEqual({
      runtimeId: 'claude-code',
      nativeSessionId: 'session-1',
      sessionPathHint: '/old/path.jsonl',
    })
  })

  it('rejects malformed persisted documents at the boundary', () => {
    expect(() =>
      cliSessionIndexDocumentSchema.parse({
        schemaVersion: CLI_SESSION_INDEX_SCHEMA_VERSION,
        sessions: {
          broken: { runtimeId: 'other', nativeSessionId: '' },
        },
      }),
    ).toThrow()
  })
})
