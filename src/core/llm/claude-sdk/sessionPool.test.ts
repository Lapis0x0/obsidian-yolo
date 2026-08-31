import type { Options } from '@yolo/claude-agent-sdk-runtime'

import type {
  ClaudeProcessSupport,
  ClaudeSdkModule,
} from '../../cli-runtime/claude/types'

import { claudeSdkSessionPool } from './sessionPool'

const createSdk = (): ClaudeSdkModule =>
  ({
    query: () => ({
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<never> => new Promise(() => {}),
      }),
      setModel: jest.fn().mockResolvedValue(undefined),
      interrupt: jest.fn().mockResolvedValue(undefined),
      close: jest.fn(),
    }),
  }) as unknown as ClaudeSdkModule

const processSupport = {
  cliPath: '/usr/local/bin/claude',
  nodePath: null,
  env: {},
  createAbortController: () => new AbortController(),
  spawnClaudeCodeProcess: jest.fn(),
} as unknown as ClaudeProcessSupport

const buildOptions = (): Options => ({}) as Options

const acquire = (spec: {
  key: string
  resume?: string
  resumeAt?: string
  model?: string
  startupFingerprint?: string
}) =>
  claudeSdkSessionPool.acquire({
    sdk: createSdk(),
    processSupport,
    spec: { startupFingerprint: 'fp', ...spec },
    buildOptions,
  })

describe('ClaudeSdkSessionPool', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    claudeSdkSessionPool.disposeAll()
  })

  afterEach(() => {
    claudeSdkSessionPool.disposeAll()
    jest.useRealTimers()
  })

  it('reuses a warm session for the same conversation and session id', async () => {
    const first = await acquire({ key: 'c1' })
    first.sessionId = 'native-1'
    const second = await acquire({ key: 'c1', resume: 'native-1' })
    expect(second).toBe(first)
  })

  it('respawns when the startup fingerprint changed', async () => {
    const first = await acquire({ key: 'c1' })
    first.sessionId = 'native-1'
    const second = await acquire({
      key: 'c1',
      resume: 'native-1',
      startupFingerprint: 'different',
    })
    expect(second).not.toBe(first)
  })

  it('respawns for a fork, which cannot be applied to a live session', async () => {
    const first = await acquire({ key: 'c1' })
    first.sessionId = 'native-1'
    const second = await acquire({
      key: 'c1',
      resume: 'native-1',
      resumeAt: 'uuid-1',
    })
    expect(second).not.toBe(first)
  })

  it('respawns when the stored session id moved on', async () => {
    const first = await acquire({ key: 'c1' })
    first.sessionId = 'native-1'
    const second = await acquire({ key: 'c1', resume: 'native-2' })
    expect(second).not.toBe(first)
  })

  it('holds only one warm session, evicting the previous conversation', async () => {
    const first = await acquire({ key: 'c1' })
    await acquire({ key: 'c2' })
    expect(first.dead).toBe(true)
  })

  it('switches models on a reused session instead of respawning', async () => {
    const first = await acquire({ key: 'c1', model: 'sonnet' })
    first.sessionId = 'native-1'
    const second = await acquire({
      key: 'c1',
      resume: 'native-1',
      model: 'opus',
    })
    expect(second).toBe(first)
    expect(second.model).toBe('opus')
  })

  it('closes a released session once it has been idle long enough', async () => {
    const session = await acquire({ key: 'c1' })
    claudeSdkSessionPool.release('c1')
    jest.advanceTimersByTime(4 * 60 * 1000)
    expect(session.dead).toBe(false)
    jest.advanceTimersByTime(60 * 1000)
    expect(session.dead).toBe(true)
  })

  it('cancels the idle timer when the conversation comes back', async () => {
    const session = await acquire({ key: 'c1' })
    session.sessionId = 'native-1'
    claudeSdkSessionPool.release('c1')
    jest.advanceTimersByTime(4 * 60 * 1000)
    const again = await acquire({ key: 'c1', resume: 'native-1' })
    jest.advanceTimersByTime(10 * 60 * 1000)
    expect(again).toBe(session)
    expect(session.dead).toBe(false)
  })
})
