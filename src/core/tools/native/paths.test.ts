jest.mock('obsidian')

/* eslint-disable import/no-nodejs-modules -- path expectations are computed with the same node APIs the module under test uses */
import * as os from 'node:os'
import * as path from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import { FileSystemAdapter } from 'obsidian'
import type { App } from 'obsidian'

import {
  OUTSIDE_VAULT_ALLOWANCE_KEY,
  getExtraAllowanceKeysForRequest,
  getVaultBasePath,
  isAbsoluteNativePath,
  isInsideVault,
  resolveNativePath,
  resolveNativePathWithin,
  toEditSummaryPath,
} from './paths'

const VAULT = path.resolve('/tmp/yolo-vault')

const appWithBasePath = (basePath: string): App => {
  const adapter = new FileSystemAdapter()
  adapter.getBasePath = () => basePath
  return { vault: { adapter } } as unknown as App
}

const appWithoutFileSystemAdapter = (): App =>
  ({ vault: { adapter: {} } }) as unknown as App

describe('getVaultBasePath', () => {
  it('returns the adapter base path on a filesystem-backed vault', () => {
    expect(getVaultBasePath(appWithBasePath(VAULT))).toBe(VAULT)
  })

  it('throws on a non-filesystem adapter rather than guessing a root', () => {
    expect(() => getVaultBasePath(appWithoutFileSystemAdapter())).toThrow(
      /not backed by the local filesystem/,
    )
  })
})

describe('resolveNativePath', () => {
  const app = appWithBasePath(VAULT)

  it('resolves a relative path against the vault root', async () => {
    await expect(resolveNativePath(app, 'notes/a.md')).resolves.toBe(
      path.join(VAULT, 'notes/a.md'),
    )
  })

  it('keeps an absolute path, normalized', async () => {
    await expect(resolveNativePath(app, '/etc/./hosts')).resolves.toBe(
      path.resolve('/etc/hosts'),
    )
  })

  it('collapses .. segments, including out of the vault', async () => {
    await expect(resolveNativePath(app, '../outside/x.txt')).resolves.toBe(
      path.resolve(VAULT, '../outside/x.txt'),
    )
  })

  it('expands ~ to the home directory', async () => {
    await expect(resolveNativePath(app, '~')).resolves.toBe(
      path.resolve(os.homedir()),
    )
    await expect(resolveNativePath(app, '~/Downloads/x.csv')).resolves.toBe(
      path.join(os.homedir(), 'Downloads/x.csv'),
    )
  })

  it('does not expand a bare ~ prefix that is part of a name', async () => {
    await expect(resolveNativePath(app, '~notes/a.md')).resolves.toBe(
      path.join(VAULT, '~notes/a.md'),
    )
  })

  it('trims surrounding whitespace and rejects an empty path', async () => {
    await expect(resolveNativePath(app, '  notes/a.md  ')).resolves.toBe(
      path.join(VAULT, 'notes/a.md'),
    )
    await expect(resolveNativePath(app, '   ')).rejects.toThrow(
      'path must be a non-empty string.',
    )
  })

  it('throws for a relative path when the vault has no filesystem adapter', async () => {
    await expect(
      resolveNativePath(appWithoutFileSystemAdapter(), 'notes/a.md'),
    ).rejects.toThrow(/not backed by the local filesystem/)
  })
})

describe('isInsideVault', () => {
  it('accepts the vault root itself and its descendants', () => {
    expect(isInsideVault('/home/me/vault', '/home/me/vault')).toBe(true)
    expect(isInsideVault('/home/me/vault/a/b.md', '/home/me/vault')).toBe(true)
  })

  it('rejects a sibling directory that merely shares the prefix', () => {
    expect(isInsideVault('/home/me/vault-backup/a.md', '/home/me/vault')).toBe(
      false,
    )
  })

  it('rejects a path above the vault', () => {
    expect(isInsideVault('/home/me/other.md', '/home/me/vault')).toBe(false)
    expect(isInsideVault('/home/me', '/home/me/vault')).toBe(false)
  })

  it('ignores trailing separators on either side', () => {
    expect(isInsideVault('/home/me/vault/', '/home/me/vault')).toBe(true)
    expect(isInsideVault('/home/me/vault/a.md', '/home/me/vault/')).toBe(true)
    expect(isInsideVault('/home/me/vault//a.md', '/home/me/vault')).toBe(true)
  })

  it('works when the vault is the filesystem root', () => {
    expect(isInsideVault('/anything', '/')).toBe(true)
    expect(isInsideVault('/', '/')).toBe(true)
  })

  it('treats backslashes as separators', () => {
    expect(isInsideVault('C:\\vault\\a\\b.md', 'C:\\vault')).toBe(true)
    expect(isInsideVault('C:\\vault-backup\\a.md', 'C:\\vault')).toBe(false)
  })

  it('compares case-insensitively for Windows-shaped paths', () => {
    expect(isInsideVault('c:\\Vault\\A.md', 'C:\\vault')).toBe(true)
    expect(isInsideVault('C:/VAULT/notes/a.md', 'c:/vault')).toBe(true)
    expect(
      isInsideVault('\\\\srv\\share\\Vault\\a.md', '\\\\srv\\share\\vault'),
    ).toBe(true)
  })

  it('stays case-sensitive for POSIX paths', () => {
    expect(isInsideVault('/home/me/VAULT/a.md', '/home/me/vault')).toBe(false)
  })

  it('rejects an empty vault base path instead of matching everything', () => {
    expect(isInsideVault('/home/me/vault/a.md', '')).toBe(false)
  })
})

describe('resolveNativePathWithin', () => {
  // The gateway's approval decision and the tool's own write go through this
  // one function, so what it does off-platform matters: these cases are the
  // Windows shapes a macOS/Linux `path.resolve` could never be asked about.
  const windowsBoundary = {
    vaultBasePath: 'C:\\Users\\me\\vault',
    homeDir: 'C:\\Users\\me',
  }

  it('resolves a relative path against a Windows vault root', () => {
    expect(resolveNativePathWithin(windowsBoundary, 'notes/a.md')).toBe(
      'C:\\Users\\me\\vault\\notes\\a.md',
    )
  })

  it('collapses .. out of a Windows vault root', () => {
    expect(resolveNativePathWithin(windowsBoundary, '..\\other\\x.txt')).toBe(
      'C:\\Users\\me\\other\\x.txt',
    )
  })

  it('expands ~ against the boundary home directory, not the machine one', () => {
    expect(resolveNativePathWithin(windowsBoundary, '~/Downloads/x.csv')).toBe(
      'C:\\Users\\me\\Downloads\\x.csv',
    )
  })

  it('keeps a UNC root intact', () => {
    expect(
      resolveNativePathWithin(windowsBoundary, '\\\\srv\\share\\a.md'),
    ).toBe('\\\\srv\\share\\a.md')
  })

  it('refuses to expand ~ when the boundary has no home directory', () => {
    expect(() =>
      resolveNativePathWithin(
        { vaultBasePath: '/home/me/vault', homeDir: '' },
        '~/x.md',
      ),
    ).toThrow(/no home directory/)
  })

  it('never escapes the root with leading ..', () => {
    expect(
      resolveNativePathWithin(
        { vaultBasePath: '/', homeDir: '/home/me' },
        '../../etc/hosts',
      ),
    ).toBe('/etc/hosts')
  })
})

describe('getExtraAllowanceKeysForRequest', () => {
  it('grants the shared boundary permission only for an outside-vault call', () => {
    expect(getExtraAllowanceKeysForRequest({ metadata: {} })).toEqual([])
    expect(
      getExtraAllowanceKeysForRequest({
        metadata: { outsideVaultPath: '/etc/hosts' },
      }),
    ).toEqual([OUTSIDE_VAULT_ALLOWANCE_KEY])
  })
})

describe('toEditSummaryPath', () => {
  it('returns the vault-relative path for a file inside the vault', () => {
    expect(toEditSummaryPath('/home/me/vault/a/b.md', '/home/me/vault')).toBe(
      'a/b.md',
    )
    expect(toEditSummaryPath('/home/me/vault/a.md', '/home/me/vault/')).toBe(
      'a.md',
    )
  })

  it('keeps the absolute path for a file outside the vault', () => {
    expect(toEditSummaryPath('/home/me/other.md', '/home/me/vault')).toBe(
      '/home/me/other.md',
    )
    expect(
      toEditSummaryPath('/home/me/vault-backup/a.md', '/home/me/vault'),
    ).toBe('/home/me/vault-backup/a.md')
  })

  it('produces exactly the shape isAbsoluteNativePath tells apart', () => {
    expect(
      isAbsoluteNativePath(
        toEditSummaryPath('/home/me/vault/a.md', '/home/me/vault'),
      ),
    ).toBe(false)
    expect(
      isAbsoluteNativePath(
        toEditSummaryPath('/home/me/other.md', '/home/me/vault'),
      ),
    ).toBe(true)
  })

  it('uses forward slashes for a Windows vault path', () => {
    expect(toEditSummaryPath('C:\\vault\\a\\b.md', 'C:\\vault')).toBe('a/b.md')
  })
})
