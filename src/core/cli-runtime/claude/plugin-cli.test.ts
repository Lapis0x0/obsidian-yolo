/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only Claude plugin CLI boundary */
import { execFile } from 'node:child_process'
/* eslint-enable import/no-nodejs-modules */

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}))

jest.mock('./process', () => ({
  resolveClaudeProcessSupport: jest.fn(),
}))

import {
  disablePlugin,
  enablePlugin,
  installPlugin,
  listPlugins,
  runClaudePluginCli,
  uninstallPlugin,
  updatePlugin,
} from './plugin-cli'
import { resolveClaudeProcessSupport } from './process'
import type { ClaudeProcessSupport } from './types'

const mockedExecFile = jest.mocked(execFile)
const mockedResolveProcessSupport = jest.mocked(resolveClaudeProcessSupport)

type ExecFileCallback = (
  error: unknown,
  result: { stdout: string; stderr: string },
) => void

const processSupport: ClaudeProcessSupport = {
  cliPath: '/usr/local/bin/claude',
  nodePath: null,
  env: { PATH: '/usr/local/bin' },
  createAbortController: () => new AbortController(),
  spawnClaudeCodeProcess:
    jest.fn() as unknown as ClaudeProcessSupport['spawnClaudeCodeProcess'],
}

const mockExecOnce = (
  handler: (
    file: string,
    args: readonly string[],
  ) => { stdout?: string; stderr?: string; error?: unknown },
): void => {
  mockedExecFile.mockImplementationOnce(
    (file: unknown, args: unknown, _options: unknown, callback: unknown) => {
      const result = handler(file as string, args as readonly string[])
      const cb = callback as ExecFileCallback
      if (result.error) {
        cb(result.error, {
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        })
      } else {
        cb(null, { stdout: result.stdout ?? '', stderr: result.stderr ?? '' })
      }
      return {} as ReturnType<typeof execFile>
    },
  )
}

describe('Claude plugin CLI runner', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedResolveProcessSupport.mockResolvedValue(processSupport)
  })

  it('parses the installed and available plugins from list --json --available', async () => {
    const payload = {
      installed: [
        {
          id: 'agent-sdk-dev@claude-plugins-official',
          version: 'unknown',
          scope: 'user',
          enabled: true,
          installPath: '/Users/me/.claude/plugins/agent-sdk-dev',
          installedAt: '2026-08-01T00:00:00.000Z',
          lastUpdated: '2026-08-01T00:00:00.000Z',
        },
      ],
      available: [
        {
          pluginId: 'agent-sdk-dev@claude-plugins-official',
          name: 'agent-sdk-dev',
          description: 'Agent SDK dev tools',
          marketplaceName: 'claude-plugins-official',
          source: 'https://example.com/marketplace.json',
          installCount: 123,
        },
      ],
    }
    mockExecOnce(() => ({ stdout: JSON.stringify(payload), stderr: '' }))

    const result = await listPlugins()

    expect(result).toEqual({ ok: true, data: payload })
    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      ['plugin', 'list', '--json', '--available'],
      expect.objectContaining({
        env: processSupport.env,
        timeout: 20_000,
      }),
      expect.any(Function),
    )
  })

  it('returns ok:false with the stderr text on a non-zero exit', async () => {
    mockExecOnce(() => ({
      stdout: '',
      stderr: 'Error: plugin not found',
      error: Object.assign(new Error('Command failed'), {
        stdout: '',
        stderr: 'Error: plugin not found',
        code: 1,
      }),
    }))

    const result = await runClaudePluginCli(['enable', 'missing-plugin'])

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('plugin not found')
    }
  })

  it('returns ok:false when JSON parsing fails', async () => {
    mockExecOnce(() => ({ stdout: 'not json', stderr: '' }))

    const result = await listPlugins()

    expect(result.ok).toBe(false)
  })

  it('builds install argv with a default user scope', async () => {
    mockExecOnce(() => ({ stdout: '✔ Successfully installed', stderr: '' }))

    await installPlugin('agent-sdk-dev@claude-plugins-official')

    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      [
        'plugin',
        'install',
        'agent-sdk-dev@claude-plugins-official',
        '--scope',
        'user',
      ],
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('builds install argv with an explicit scope', async () => {
    mockExecOnce(() => ({ stdout: '✔ Successfully installed', stderr: '' }))

    await installPlugin('agent-sdk-dev@claude-plugins-official', 'project')

    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      [
        'plugin',
        'install',
        'agent-sdk-dev@claude-plugins-official',
        '--scope',
        'project',
      ],
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('builds uninstall argv without --prune', async () => {
    mockExecOnce(() => ({ stdout: '✔ Successfully uninstalled', stderr: '' }))

    await uninstallPlugin('agent-sdk-dev@claude-plugins-official', 'user')

    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      [
        'plugin',
        'uninstall',
        'agent-sdk-dev@claude-plugins-official',
        '--scope',
        'user',
      ],
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('omits --scope for enable/disable/update when no scope is given', async () => {
    mockExecOnce(() => ({ stdout: '✔ Successfully enabled', stderr: '' }))
    await enablePlugin('agent-sdk-dev@claude-plugins-official')
    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      ['plugin', 'enable', 'agent-sdk-dev@claude-plugins-official'],
      expect.any(Object),
      expect.any(Function),
    )

    mockExecOnce(() => ({ stdout: '✔ Successfully disabled', stderr: '' }))
    await disablePlugin('agent-sdk-dev@claude-plugins-official')
    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      ['plugin', 'disable', 'agent-sdk-dev@claude-plugins-official'],
      expect.any(Object),
      expect.any(Function),
    )

    mockExecOnce(() => ({ stdout: '✔ Successfully updated', stderr: '' }))
    await updatePlugin('agent-sdk-dev@claude-plugins-official')
    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      ['plugin', 'update', 'agent-sdk-dev@claude-plugins-official'],
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('includes --scope for enable/disable/update when a scope is given', async () => {
    mockExecOnce(() => ({ stdout: '✔ Successfully enabled', stderr: '' }))
    await enablePlugin('agent-sdk-dev@claude-plugins-official', {
      scope: 'project',
    })
    expect(mockedExecFile).toHaveBeenCalledWith(
      '/usr/local/bin/claude',
      [
        'plugin',
        'enable',
        'agent-sdk-dev@claude-plugins-official',
        '--scope',
        'project',
      ],
      expect.any(Object),
      expect.any(Function),
    )
  })

  it('reuses the resolved process support for the same configured CLI path', async () => {
    mockExecOnce(() => ({ stdout: '{}', stderr: '' }))
    mockExecOnce(() => ({ stdout: '{}', stderr: '' }))

    await runClaudePluginCli(['list', '--json'], {
      configuredCliPath: '/custom/claude',
      parseJson: true,
    })
    await runClaudePluginCli(['list', '--json'], {
      configuredCliPath: '/custom/claude',
      parseJson: true,
    })

    expect(mockedResolveProcessSupport).toHaveBeenCalledTimes(1)
  })
})
