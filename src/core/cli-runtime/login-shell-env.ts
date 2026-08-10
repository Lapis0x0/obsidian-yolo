/**
 * Obsidian's GUI process inherits a minimal environment — on macOS the PATH
 * is typically just `/usr/bin:/bin:/usr/sbin:/sbin` — so CLI executable
 * detection must merge the user's login-shell environment (nvm, homebrew,
 * pnpm, and anything else appended in shell rc files) before probing.
 */
export const loadLoginShellEnvironment = async (): Promise<
  Record<string, string | undefined>
> => {
  const inherited = { ...process.env }
  try {
    const { shellEnvSync } = await import('shell-env')
    return { ...inherited, ...shellEnvSync() }
  } catch {
    return inherited
  }
}
