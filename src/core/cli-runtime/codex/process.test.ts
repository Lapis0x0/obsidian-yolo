import { CodexAppServerProcess } from './process'

jest.mock('shell-env', () => ({ shellEnvSync: () => ({}) }))

describe('CodexAppServerProcess', () => {
  it('rejects a missing executable without leaking an uncaught child error', async () => {
    const command = `missing-codex-${Date.now()}-${Math.random()}`
    const globals = globalThis as typeof globalThis & {
      require?: NodeJS.Require
    }
    const originalRequire = globals.require
    globals.require = require

    try {
      await expect(
        CodexAppServerProcess.start({ command, cwd: process.cwd() }),
      ).rejects.toThrow(
        new RegExp(
          `Failed to start Codex app-server \\(${command}\\).*(ENOENT|not found)`,
        ),
      )
    } finally {
      globals.require = originalRequire
    }
  })
})
