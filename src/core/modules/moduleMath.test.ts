import type {
  MathLayout,
  MathRequest,
  RuntimeComponentLease,
} from '../runtime-components/contracts'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ModuleMathCapabilityProvider } from './moduleMath'

const layout: MathLayout = {
  paths: ['M0 0L1 1Z'],
  pieces: [
    {
      width: 1,
      height: 0.7,
      depth: 0.2,
      after: 0,
      shapes: [
        {
          kind: 'path',
          path: 0,
          transform: [0.001, 0, 0, -0.001, 0, 0],
          color: null,
        },
      ],
    },
  ],
}

function engine() {
  const asked: MathRequest[][] = []
  let leases = 0
  const acquire = async (): Promise<
    RuntimeComponentLease<'mathjax-engine'>
  > => {
    leases += 1
    return {
      api: {
        layout: async (requests) => {
          asked.push([...requests])
          return requests.map((r) => (r.tex === 'bad' ? null : layout))
        },
        dispose: () => undefined,
      },
      release: () => {
        leases -= 1
      },
    }
  }
  return { asked, acquire, leases: () => leases }
}

describe('ModuleMathCapabilityProvider', () => {
  test('lays out through the math engine, holding it only while it works', async () => {
    const fake = engine()
    const { api } = new ModuleMathCapabilityProvider(fake.acquire).create(
      'm',
      new ModuleLifecycleScope(),
    )
    const got = await api.layout([
      { tex: 'x^2', display: false },
      { tex: 'bad', display: true },
    ])
    expect(got).toEqual([layout, null])
    expect(fake.asked).toEqual([
      [
        { tex: 'x^2', display: false },
        { tex: 'bad', display: true },
      ],
    ])
    expect(fake.leases()).toBe(0)
  })

  test('installs nothing for no formulas, and refuses a malformed one', async () => {
    const fake = engine()
    const { api } = new ModuleMathCapabilityProvider(fake.acquire).create(
      'm',
      new ModuleLifecycleScope(),
    )
    expect(await api.layout([])).toEqual([])
    expect(fake.asked).toEqual([])
    await expect(
      api.layout([{ tex: 1 } as unknown as MathRequest]),
    ).rejects.toThrow(TypeError)
  })

  test('refuses once the module is unloaded', async () => {
    const fake = engine()
    const lifecycle = new ModuleLifecycleScope()
    const { api } = new ModuleMathCapabilityProvider(fake.acquire).create(
      'm',
      lifecycle,
    )
    lifecycle.dispose()
    await expect(api.layout([{ tex: 'x', display: false }])).rejects.toThrow(
      'disposed',
    )
  })
})
