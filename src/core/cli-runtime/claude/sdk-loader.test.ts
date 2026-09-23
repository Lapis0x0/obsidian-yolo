import { Platform } from 'obsidian'

import type {
  RuntimeComponentId,
  RuntimeComponentLease,
} from '../../runtime-components/contracts'
import { setRuntimeComponentAcquirerForTests } from '../../runtime-components/runtimeComponentAccess'

import { loadClaudeAgentSdk } from './sdk-loader'
import type { ClaudeSdkModule } from './types'

const sdk = {
  query: jest.fn(),
  getSessionMessages: jest.fn(),
  getSubagentMessages: jest.fn(),
} as unknown as ClaudeSdkModule

describe('loadClaudeAgentSdk', () => {
  const acquired: RuntimeComponentId[] = []
  const release = jest.fn()

  beforeEach(() => {
    acquired.length = 0
    release.mockClear()
    setRuntimeComponentAcquirerForTests(
      async <I extends RuntimeComponentId>(id: I) => {
        acquired.push(id)
        return { api: sdk, release } as unknown as RuntimeComponentLease<I>
      },
    )
  })

  afterEach(() => {
    Platform.isDesktop = true
    setRuntimeComponentAcquirerForTests(null)
  })

  it('returns the claude-agent-sdk component API without holding its lease', async () => {
    await expect(loadClaudeAgentSdk()).resolves.toBe(sdk)
    expect(acquired).toEqual(['claude-agent-sdk'])
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('reports a component that cannot be acquired on every call', async () => {
    setRuntimeComponentAcquirerForTests(async (id) => {
      throw new Error(`Runtime component "${id}" is disabled`)
    })
    await expect(loadClaudeAgentSdk()).rejects.toThrow('disabled')
    await expect(loadClaudeAgentSdk()).rejects.toThrow('disabled')
  })

  it('refuses before touching the component off desktop', async () => {
    Platform.isDesktop = false
    await expect(loadClaudeAgentSdk()).rejects.toThrow(
      'only available on desktop',
    )
    expect(acquired).toEqual([])
  })
})
