type SessionPathOptions = {
  platform?: NodeJS.Platform
  realpath?: (path: string) => Promise<string>
}

const isSameOrDescendant = (
  path: typeof import('node:path').posix,
  root: string,
  candidate: string,
): boolean => {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

/**
 * Checks whether a provider-native session cwd belongs to the current vault.
 * Existing paths use their real locations so symlinks cannot escape the vault;
 * stale transcript paths fall back to platform-correct lexical comparison.
 */
export const isSessionPathInVault = async (
  vaultRoot: string,
  candidate: string,
  options: SessionPathOptions = {},
): Promise<boolean> => {
  // eslint-disable-next-line import/no-nodejs-modules -- CLI runtimes call this only behind the desktop capability gate
  const pathModule = await import('node:path')
  const platform = options.platform ?? process.platform
  const path = platform === 'win32' ? pathModule.win32 : pathModule.posix
  if (!path.isAbsolute(vaultRoot) || !path.isAbsolute(candidate)) return false

  const lexicalRoot = path.resolve(vaultRoot)
  const lexicalCandidate = path.resolve(candidate)
  const lexicalResult = isSameOrDescendant(path, lexicalRoot, lexicalCandidate)

  try {
    const realpath =
      options.realpath ??
      // eslint-disable-next-line import/no-nodejs-modules -- CLI runtimes call this only behind the desktop capability gate
      (await import('node:fs/promises')).realpath
    const [realRoot, realCandidate] = await Promise.all([
      realpath(lexicalRoot),
      realpath(lexicalCandidate),
    ])
    return isSameOrDescendant(
      path,
      path.resolve(realRoot),
      path.resolve(realCandidate),
    )
  } catch {
    return lexicalResult
  }
}
