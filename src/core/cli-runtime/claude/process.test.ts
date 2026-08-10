import type { SpawnOptions } from '@yolo/claude-agent-sdk-runtime'

import {
  createElectronSpawnFunction,
  resolveClaudeProcessSupport,
} from './process'

describe('Claude desktop process support', () => {
  it('resolves the local CLI and a full Node path from the desktop environment', async () => {
    const spawn = jest.fn(() => ({
      stdin: {},
      stdout: {},
      stderr: undefined,
      kill: jest.fn(),
    }))
    const support = await resolveClaudeProcessSupport({
      configuredCliPath: undefined,
      loadEnvironment: async () => ({
        PATH: '/home/me/.local/bin:/usr/local/bin:/usr/bin',
      }),
      platform: 'linux',
      homedir: '/home/me',
      fileExists: async (path) =>
        path === '/home/me/.local/bin/claude' || path === '/usr/local/bin/node',
      spawn,
    })

    expect(support.cliPath).toBe('/home/me/.local/bin/claude')
    const spawnOptions = {
      command: 'node',
      args: ['cli.js'],
      cwd: '/vault',
      env: support.env,
      signal: new AbortController().signal,
    } as SpawnOptions
    support.spawnClaudeCodeProcess(spawnOptions)
    expect(spawn).toHaveBeenCalledWith(
      '/usr/local/bin/node',
      ['cli.js'],
      expect.objectContaining({
        cwd: '/vault',
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      }),
    )
  })

  it('wraps JavaScript CLI entrypoints with the resolved Node executable', () => {
    const child = {
      stdin: {},
      stdout: {},
      stderr: undefined,
      kill: jest.fn(),
    }
    const spawn = jest.fn(() => child)
    const customSpawn = createElectronSpawnFunction({
      spawn,
      nodePath: '/usr/bin/node',
    })

    customSpawn({
      command: '/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      args: ['--version'],
      cwd: '/vault',
      env: {},
      signal: new AbortController().signal,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/node',
      ['/npm/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--version'],
      expect.any(Object),
    )
  })

  it('does not require Node when Claude is a native executable', async () => {
    const child = {
      stdin: {},
      stdout: {},
      stderr: undefined,
      kill: jest.fn(),
    }
    const spawn = jest.fn(() => child)
    const support = await resolveClaudeProcessSupport({
      loadEnvironment: async () => ({ PATH: '/home/me/.local/bin' }),
      platform: 'linux',
      homedir: '/home/me',
      fileExists: async (path) => path === '/home/me/.local/bin/claude',
      spawn,
    })

    support.spawnClaudeCodeProcess({
      command: '/home/me/.local/bin/claude',
      args: ['--version'],
      cwd: '/vault',
      env: support.env,
      signal: new AbortController().signal,
    })

    expect(spawn).toHaveBeenCalledWith(
      '/home/me/.local/bin/claude',
      ['--version'],
      expect.any(Object),
    )
  })

  it('resolves Windows npm cmd shims to the Node package entrypoint', async () => {
    const spawn = jest.fn(() => ({
      stdin: {},
      stdout: {},
      stderr: undefined,
      kill: jest.fn(),
    }))
    const support = await resolveClaudeProcessSupport({
      configuredCliPath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      loadEnvironment: async () => ({
        Path: 'C:\\Program Files\\nodejs',
      }),
      platform: 'win32',
      homedir: 'C:\\Users\\me',
      fileExists: async (path) =>
        path ===
          'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' ||
        path === 'C:\\Program Files\\nodejs\\node.exe',
      spawn,
    })

    expect(support.cliPath).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    )
  })

  it('does not select the extensionless Windows npm shim over the package entrypoint', async () => {
    const support = await resolveClaudeProcessSupport({
      loadEnvironment: async () => ({
        Path: 'C:\\nvm4w\\node_global',
      }),
      platform: 'win32',
      homedir: 'C:\\Users\\me',
      fileExists: async (path) =>
        path ===
        'C:\\nvm4w\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    })

    expect(support.cliPath).toBe(
      'C:\\nvm4w\\node_global\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    )
  })
})
