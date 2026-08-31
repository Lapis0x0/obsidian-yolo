import { FileSystemAdapter } from 'obsidian'

import type {
  EmbeddingEngineComponentApi,
  EmbeddingSession,
  RuntimeComponentId,
  RuntimeComponentLease,
} from '../../runtime-components/contracts'
import {
  setRuntimeComponentAcquirerForTests,
  setRuntimeComponentAssetReaderForTests,
} from '../../runtime-components/runtimeComponentAccess'

import type { LocalEmbeddingCatalogEntry } from './catalog'
import {
  type LocalEmbeddingSessionClient,
  createLocalEmbeddingClient,
} from './client'
import { LocalEmbeddingModelManager } from './manager'

const ENTRY: LocalEmbeddingCatalogEntry = {
  id: 'test-model',
  hfRepo: 'Xenova/test-model',
  revision: 'a'.repeat(40),
  displayName: 'Test Model',
  languages: ['en'],
  license: 'MIT',
  dimension: 3,
  maxTokens: 128,
  pooling: 'mean',
  normalize: true,
  files: [{ path: 'config.json', byteSize: 4, sha256: 'x'.repeat(64) }],
  totalBytes: 4,
  prefixes: { query: 'query: ', document: 'passage: ' },
}

function createManager(): LocalEmbeddingModelManager {
  const adapter = new FileSystemAdapter()
  Object.assign(adapter, { getFullPath: (path: string) => `/vault/${path}` })
  return new LocalEmbeddingModelManager({
    adapter,
    manifest: { id: 'yolo' },
    configDir: '.config',
    getEndpoint: () => 'https://huggingface.co',
    catalog: [ENTRY],
  })
}

function fakeVector(seed: number): Float32Array {
  return new Float32Array([seed, seed + 1, seed + 2])
}

describe('createLocalEmbeddingClient', () => {
  let manager: LocalEmbeddingModelManager
  let embed: jest.Mock
  let sessionDispose: jest.Mock
  let createSession: jest.Mock
  let release: jest.Mock
  let fakeApi: EmbeddingEngineComponentApi
  let clients: LocalEmbeddingSessionClient[]

  /** Tracked so `afterEach` can dispose every session (and its idle timer). */
  function makeClient(): LocalEmbeddingSessionClient {
    const client = createLocalEmbeddingClient({ catalogEntry: ENTRY, manager })
    clients.push(client)
    return client
  }

  beforeEach(() => {
    jest.useRealTimers()
    clients = []
    manager = createManager()
    jest.spyOn(manager, 'getState').mockReturnValue({ status: 'ready' })
    jest
      .spyOn(manager, 'readModelFile')
      .mockResolvedValue(new Uint8Array([1, 2, 3]))

    embed = jest.fn(async (texts: string[]) =>
      texts.map((_t, i) => fakeVector(i)),
    )
    sessionDispose = jest.fn(async () => undefined)
    const fakeSession: EmbeddingSession = { embed, dispose: sessionDispose }
    createSession = jest.fn(async () => fakeSession)
    fakeApi = {
      probeEnvironment: () => ({ ok: true, webgpu: false, threads: 1 }),
      createSession,
      dispose: jest.fn(async () => undefined),
    }
    release = jest.fn()
    setRuntimeComponentAcquirerForTests((async () => ({
      api: fakeApi,
      release,
    })) as unknown as <I extends RuntimeComponentId>(
      id: I,
    ) => Promise<RuntimeComponentLease<I>>)
    setRuntimeComponentAssetReaderForTests(async () => new Uint8Array([9]))
  })

  afterEach(async () => {
    // Every test that reaches `ensureSession()` leaves a live 10-minute idle
    // timer running; not disposing it here would leak a real `setTimeout`
    // per test and keep the Jest worker process alive after the run
    // completes ("Jest did not exit ... asynchronous operations that
    // weren't stopped").
    await Promise.all(clients.map((client) => client.dispose()))
    setRuntimeComponentAcquirerForTests(null)
    setRuntimeComponentAssetReaderForTests(null)
    jest.useRealTimers()
  })

  it('merges concurrent getEmbedding calls into a single session.embed() batch', async () => {
    const client = makeClient()

    const results = await Promise.all([
      client.getEmbedding('a'),
      client.getEmbedding('b'),
      client.getEmbedding('c'),
    ])

    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed.mock.calls[0][0]).toEqual([
      'passage: a',
      'passage: b',
      'passage: c',
    ])
    expect(results).toEqual([
      [0, 1, 2],
      [1, 2, 3],
      [2, 3, 4],
    ])
  })

  it('flushes a batch of exactly BATCH_SIZE once that many requests are queued, in one session.embed() call', async () => {
    const client = makeClient()
    const promises = Array.from({ length: 16 }, (_v, i) =>
      client.getEmbedding(`t${i}`),
    )
    await Promise.all(promises)

    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed.mock.calls[0][0]).toHaveLength(16)
  })

  it('flushes a 17th request in a second session.embed() call rather than growing the first batch', async () => {
    const client = makeClient()
    const promises = Array.from({ length: 17 }, (_v, i) =>
      client.getEmbedding(`t${i}`),
    )
    await Promise.all(promises)

    expect(embed).toHaveBeenCalledTimes(2)
    expect(embed.mock.calls[0][0]).toHaveLength(16)
    expect(embed.mock.calls[1][0]).toHaveLength(1)
  })

  it('applies the query prefix for kind "query" and the document prefix for kind "document"', async () => {
    const client = makeClient()

    await Promise.all([
      client.getEmbedding('find this', { kind: 'query' }),
      client.getEmbedding('a chunk', { kind: 'document' }),
    ])

    expect(embed.mock.calls[0][0]).toEqual([
      'query: find this',
      'passage: a chunk',
    ])
  })

  it('creates only one session across multiple sequential batches', async () => {
    const client = makeClient()
    await client.getEmbedding('a')
    await client.getEmbedding('b')
    await client.getEmbedding('c')

    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('rejects all queued items in a batch when session.embed() throws', async () => {
    embed.mockRejectedValueOnce(new Error('inference failed'))
    const client = makeClient()

    await expect(
      Promise.all([client.getEmbedding('a'), client.getEmbedding('b')]),
    ).rejects.toThrow('inference failed')
  })

  it('rejects immediately when the model is not installed', async () => {
    jest.spyOn(manager, 'getState').mockReturnValue({ status: 'not-installed' })
    const client = makeClient()

    await expect(client.getEmbedding('a')).rejects.toThrow(/not installed/)
  })

  it('dispose() tears down the session and releases the runtime component lease', async () => {
    const client = makeClient()
    await client.getEmbedding('a')

    await client.dispose()

    expect(sessionDispose).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('disposes the idle session after the idle timeout and re-creates it on next use', async () => {
    jest.useFakeTimers()
    const client = makeClient()
    await client.getEmbedding('a')
    expect(createSession).toHaveBeenCalledTimes(1)

    jest.advanceTimersByTime(10 * 60 * 1000 + 1)
    // Let the disposeSession() promise chain settle.
    await Promise.resolve()
    await Promise.resolve()

    expect(sessionDispose).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)

    jest.useRealTimers()
    await client.getEmbedding('b')
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('shares a single session across two clients for the same catalog id', async () => {
    const clientA = makeClient()
    const clientB = makeClient()

    await Promise.all([clientA.getEmbedding('a'), clientB.getEmbedding('b')])

    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('keeps the shared session alive when one of two clients disposes, and tears it down once the last one does', async () => {
    const clientA = makeClient()
    const clientB = makeClient()
    await Promise.all([clientA.getEmbedding('a'), clientB.getEmbedding('b')])

    await clientA.dispose()
    expect(sessionDispose).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()

    // clientB still holds a reference — getEmbedding must keep working
    // against the same (never recreated) session.
    await clientB.getEmbedding('c')
    expect(createSession).toHaveBeenCalledTimes(1)

    await clientB.dispose()
    expect(sessionDispose).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('dispose() is idempotent and every getEmbedding() call after it rejects without touching the session', async () => {
    const client = makeClient()
    await client.getEmbedding('a')

    await client.dispose()
    await client.dispose() // must not double-release or throw

    await expect(client.getEmbedding('b')).rejects.toThrow(/disposed/)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('releases the runtime component lease even when session.dispose() throws', async () => {
    sessionDispose.mockRejectedValueOnce(new Error('worker already dead'))
    const client = makeClient()
    await client.getEmbedding('a')

    await client.dispose()

    expect(release).toHaveBeenCalledTimes(1)
  })

  it('drops a session that fails mid-embed and creates a fresh one for the next call', async () => {
    embed.mockRejectedValueOnce(new Error('inference failed'))
    const client = makeClient()

    await expect(client.getEmbedding('a')).rejects.toThrow('inference failed')
    // The broken session must have been torn down as part of the failure,
    // not left around to fail every subsequent call until the idle timer
    // eventually recycles it 10 minutes later.
    expect(release).toHaveBeenCalledTimes(1)

    const result = await client.getEmbedding('b')
    expect(createSession).toHaveBeenCalledTimes(2)
    expect(result).toEqual([0, 1, 2])
  })

  it('tears down and rejects once the manager reports the model no longer ready, instead of continuing to serve a stale session', async () => {
    const client = makeClient()
    await client.getEmbedding('a')
    expect(sessionDispose).not.toHaveBeenCalled()

    // Simulates the model being deleted (or "remove all") while its session
    // is still loaded/idle in the Worker.
    jest.spyOn(manager, 'getState').mockReturnValue({ status: 'not-installed' })

    await expect(client.getEmbedding('b')).rejects.toThrow(/not installed/)
    expect(sessionDispose).toHaveBeenCalledTimes(1)
  })
})
