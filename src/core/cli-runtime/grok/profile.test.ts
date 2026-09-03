import { grokAgentProfile } from './profile'
import { resolveGrokCommand } from './resolve-command'

jest.mock('./resolve-command', () => ({
  resolveGrokCommand: jest.fn(async () => ({
    command: '/bin/grok',
    args: [
      '--no-auto-update',
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio',
    ],
  })),
}))

const mockedResolveGrokCommand = jest.mocked(resolveGrokCommand)

describe('grokAgentProfile', () => {
  it('identifies Grok and delegates command resolution', async () => {
    await expect(
      grokAgentProfile.resolveCommand({ PATH: '/usr/bin' }, '/configured/grok'),
    ).resolves.toMatchObject({ command: '/bin/grok' })
    expect(grokAgentProfile.runtimeId).toBe('grok')
    expect(grokAgentProfile.displayName).toBe('Grok')
    expect(mockedResolveGrokCommand).toHaveBeenCalledWith(
      { PATH: '/usr/bin' },
      process.platform,
      '/configured/grok',
    )
  })

  it('selects only cached subscription authentication', () => {
    expect(
      grokAgentProfile.selectAuthMethod?.({
        protocolVersion: 1,
        authMethods: [
          { id: 'grok.com', name: 'Grok.com' },
          { id: 'cached_token', name: 'Cached token' },
        ],
      }),
    ).toBe('cached_token')
  })
})
