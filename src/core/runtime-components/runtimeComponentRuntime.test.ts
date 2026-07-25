import type { RuntimeComponentDefinition } from './contracts'
import { RuntimeComponentRuntime } from './runtimeComponentRuntime'

describe('RuntimeComponentRuntime', () => {
  it('rejects new leases during quiesce and disposes only after every owner releases', async () => {
    const dispose = jest.fn()
    const definition: RuntimeComponentDefinition<'tokenizer'> = {
      id: 'tokenizer',
      create: () => ({ count: (text) => text.length, dispose }),
    }
    const runtime = new RuntimeComponentRuntime()
    const first = await runtime.acquire('tokenizer', async () => definition)
    const second = await runtime.acquire('tokenizer', async () => definition)

    runtime.beginQuiesce('tokenizer')
    await expect(
      runtime.acquire('tokenizer', async () => definition),
    ).rejects.toThrow('quiescing')

    let drained = false
    const draining = runtime.drainAndDispose('tokenizer').then(() => {
      drained = true
    })
    first.release()
    await Promise.resolve()
    expect(drained).toBe(false)
    second.release()
    await draining
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
