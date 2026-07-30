import { isSessionPathInVault } from './session-path'

const unavailableRealpath = async (): Promise<string> => {
  throw new Error('path no longer exists')
}

describe('native CLI session path ownership', () => {
  it.each([
    ['/vault', true],
    ['/vault/project', true],
    ['/vault-sibling', false],
    ['/vault/../outside', false],
    ['/outside', false],
  ])('classifies POSIX path %s', async (candidate, expected) => {
    await expect(
      isSessionPathInVault('/vault', candidate, {
        platform: 'linux',
        realpath: unavailableRealpath,
      }),
    ).resolves.toBe(expected)
  })

  it('uses real paths when available to reject a symlink escape', async () => {
    const realPaths: Record<string, string> = {
      '/vault': '/real/vault',
      '/vault/link': '/outside/project',
    }
    await expect(
      isSessionPathInVault('/vault', '/vault/link', {
        platform: 'linux',
        realpath: async (path) => realPaths[path],
      }),
    ).resolves.toBe(false)
  })

  it('falls back to lexical ownership when stale paths cannot be resolved', async () => {
    await expect(
      isSessionPathInVault('/vault', '/vault/deleted-project', {
        platform: 'linux',
        realpath: unavailableRealpath,
      }),
    ).resolves.toBe(true)
  })

  it.each([
    ['C:\\Vault', 'c:\\vault\\project', true],
    ['C:\\Vault', 'C:\\VaultSibling', false],
    ['C:\\Vault', 'C:\\Vault\\..\\outside', false],
    ['C:\\Vault', 'D:\\Vault\\project', false],
  ])(
    'uses Windows lexical semantics for %s and %s',
    async (root, candidate, expected) => {
      await expect(
        isSessionPathInVault(root, candidate, {
          platform: 'win32',
          realpath: unavailableRealpath,
        }),
      ).resolves.toBe(expected)
    },
  )
})
