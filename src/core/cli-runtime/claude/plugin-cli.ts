/* eslint-disable import/no-nodejs-modules -- this module is only ever reached through the coordinator's dynamic import of the desktop CLI runtime boundary */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
/* eslint-enable import/no-nodejs-modules */

import { assertCliRuntimeAvailable } from '../desktop'

import { resolveClaudeProcessSupport } from './process'
import type { ClaudeProcessSupport } from './types'

const execFileAsync = promisify(execFile)

const CLI_TIMEOUT_MS = 20_000
// `claude plugin list --json --available` can enumerate a large marketplace
// catalog alongside installed plugins, so allow a generous buffer.
const MAX_BUFFER_BYTES = 32 * 1024 * 1024

export type ClaudePluginCliResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export type ClaudePluginScope = 'user' | 'project' | 'local'

export type ClaudePluginCliOptions = {
  configuredCliPath?: string
}

export type ClaudePluginScopedCliOptions = ClaudePluginCliOptions & {
  scope?: ClaudePluginScope
}

export type ClaudeInstalledPlugin = {
  id: string
  version: string
  scope: string
  enabled: boolean
  installPath: string
  installedAt: string
  lastUpdated: string
}

export type ClaudeAvailablePlugin = {
  pluginId: string
  name: string
  description?: string
  marketplaceName: string
  /**
   * The CLI reports either a string (e.g. a marketplace URL) or a structured
   * object here depending on the marketplace source type. Nothing in this
   * module or its UI consumes the details, so it is kept opaque.
   */
  source: unknown
  installCount?: number
}

export type ClaudePluginList = {
  installed: ClaudeInstalledPlugin[]
  available: ClaudeAvailablePlugin[]
}

/**
 * `resolveClaudeProcessSupport` re-derives the login-shell environment and
 * probes the filesystem for the CLI/Node executables, which is too heavy to
 * repeat for every plugin-management action a user takes in one sitting.
 * Cache successful resolutions per configured CLI path; failures are not
 * cached so a fixed CLI path (or install) is picked up on the next call.
 */
const processSupportCache = new Map<string, Promise<ClaudeProcessSupport>>()

const getProcessSupport = (
  configuredCliPath?: string,
): Promise<ClaudeProcessSupport> => {
  const cacheKey = configuredCliPath ?? ''
  const cached = processSupportCache.get(cacheKey)
  if (cached) return cached

  const pending = resolveClaudeProcessSupport({ configuredCliPath }).catch(
    (error: unknown) => {
      processSupportCache.delete(cacheKey)
      throw error
    },
  )
  processSupportCache.set(cacheKey, pending)
  return pending
}

const describeExecError = (error: unknown): string => {
  if (error && typeof error === 'object') {
    const { stdout, stderr, message } = error as {
      stdout?: unknown
      stderr?: unknown
      message?: unknown
    }
    const combined = [
      typeof stderr === 'string' ? stderr.trim() : '',
      typeof stdout === 'string' ? stdout.trim() : '',
    ]
      .filter(Boolean)
      .join('\n')
    if (combined) return combined
    if (typeof message === 'string' && message) return message
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs `claude plugin <args>` once and returns a typed result instead of
 * throwing. Every failure mode (CLI not found, non-zero exit, timeout,
 * malformed JSON) collapses to `{ ok: false, error }` so callers can surface
 * a single fallback path ("manage this in the terminal") without a try/catch.
 */
export const runClaudePluginCli = async <T = string>(
  args: readonly string[],
  options: ClaudePluginCliOptions & { parseJson?: boolean } = {},
): Promise<ClaudePluginCliResult<T>> => {
  assertCliRuntimeAvailable('claude-code')

  try {
    const processSupport = await getProcessSupport(options.configuredCliPath)
    const { stdout } = await execFileAsync(
      processSupport.cliPath,
      ['plugin', ...args],
      {
        env: processSupport.env,
        timeout: CLI_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
      },
    )

    if (!options.parseJson) {
      return { ok: true, data: stdout.trim() as unknown as T }
    }
    try {
      return { ok: true, data: JSON.parse(stdout) as T }
    } catch {
      return {
        ok: false,
        error: `Failed to parse Claude CLI JSON output: ${stdout.trim().slice(0, 500)}`,
      }
    }
  } catch (error) {
    return { ok: false, error: describeExecError(error) }
  }
}

export const listPlugins = (
  options: ClaudePluginCliOptions = {},
): Promise<ClaudePluginCliResult<ClaudePluginList>> =>
  runClaudePluginCli<ClaudePluginList>(['list', '--json', '--available'], {
    ...options,
    parseJson: true,
  })

export const installPlugin = (
  id: string,
  scope: ClaudePluginScope = 'user',
  options: ClaudePluginCliOptions = {},
): Promise<ClaudePluginCliResult<string>> =>
  runClaudePluginCli<string>(['install', id, '--scope', scope], options)

export const enablePlugin = (
  name: string,
  options: ClaudePluginScopedCliOptions = {},
): Promise<ClaudePluginCliResult<string>> => {
  const { scope, ...cliOptions } = options
  return runClaudePluginCli<string>(
    ['enable', name, ...(scope ? ['--scope', scope] : [])],
    cliOptions,
  )
}

export const disablePlugin = (
  name: string,
  options: ClaudePluginScopedCliOptions = {},
): Promise<ClaudePluginCliResult<string>> => {
  const { scope, ...cliOptions } = options
  return runClaudePluginCli<string>(
    ['disable', name, ...(scope ? ['--scope', scope] : [])],
    cliOptions,
  )
}

export const updatePlugin = (
  name: string,
  options: ClaudePluginScopedCliOptions = {},
): Promise<ClaudePluginCliResult<string>> => {
  const { scope, ...cliOptions } = options
  return runClaudePluginCli<string>(
    ['update', name, ...(scope ? ['--scope', scope] : [])],
    cliOptions,
  )
}

export const uninstallPlugin = (
  name: string,
  scope: ClaudePluginScope,
  options: ClaudePluginCliOptions = {},
): Promise<ClaudePluginCliResult<string>> =>
  runClaudePluginCli<string>(['uninstall', name, '--scope', scope], options)
