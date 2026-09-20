import type { AcpResolvedCommand } from '../acp/agent-profile'
import {
  expandHomePath,
  findExecutableInDirectories,
  firstEnvironmentValue,
  joinForPlatform,
  resolveConfiguredExecutable,
  resolvePathEntries,
  resolveUserHome,
} from '../executable-lookup'

export const findGrokExecutable = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string | null> => {
  const home = resolveUserHome(env, platform)
  const configuredGrokHome = firstEnvironmentValue(env, 'GROK_HOME')
  const grokHome = configuredGrokHome
    ? expandHomePath(configuredGrokHome.trim(), home, platform)
    : ''
  const grokHomeEntries = grokHome
    ? [joinForPlatform(platform, grokHome, 'bin')]
    : []
  const commonEntries =
    platform === 'win32'
      ? [home ? joinForPlatform(platform, home, '.grok', 'bin') : '']
      : [
          joinForPlatform(platform, home, '.grok', 'bin'),
          joinForPlatform(platform, home, '.local', 'bin'),
          '/usr/local/bin',
          '/opt/homebrew/bin',
          '/usr/bin',
        ]
  const names =
    platform === 'win32'
      ? ['grok.exe', 'grok.cmd', 'grok.bat', 'grok']
      : ['grok']

  return findExecutableInDirectories(
    [
      ...grokHomeEntries,
      ...resolvePathEntries(env, platform),
      ...commonEntries,
    ],
    names,
    platform,
  )
}

/** Resolve the official Grok CLI and launch a dedicated, ask-first ACP server. */
export const resolveGrokCommand = async (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  cliPathOverride?: string,
): Promise<AcpResolvedCommand | null> => {
  const home = resolveUserHome(env, platform)
  const command =
    (await resolveConfiguredExecutable(cliPathOverride, home, platform)) ??
    (await findGrokExecutable(env, platform))
  if (!command) return null
  return {
    command,
    args: [
      '--no-auto-update',
      '--permission-mode',
      'default',
      'agent',
      '--no-leader',
      'stdio',
    ],
  }
}
