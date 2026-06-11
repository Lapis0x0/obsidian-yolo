export type BashCommandFlavor = 'posix' | 'powershell'

export type BashCommandSafety =
  | {
      readonly: true
    }
  | {
      readonly: false
      reason: string
    }

export const DEFAULT_BLOCKED_PREFIXES: readonly string[] = [
  'rm',
  'dd',
  'mkfs',
  'fdisk',
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
]

export const isBlockedByCommandPrefix = (
  command: string | undefined,
  blockedPrefixes: readonly string[] = DEFAULT_BLOCKED_PREFIXES,
): boolean => {
  const trimmedCommand = command?.trimStart() ?? ''
  if (!trimmedCommand) {
    return false
  }

  return blockedPrefixes
    .map((prefix) => prefix.trim())
    .filter((prefix) => prefix.length > 0)
    .some(
      (prefix) =>
        trimmedCommand === prefix ||
        trimmedCommand.startsWith(`${prefix} `) ||
        trimmedCommand.startsWith(`${prefix}\t`),
    )
}

const POSIX_READONLY_COMMANDS = new Set([
  'basename',
  'cat',
  'cut',
  'date',
  'df',
  'dirname',
  'du',
  'egrep',
  'fd',
  'fgrep',
  'file',
  'find',
  'git',
  'grep',
  'head',
  'ls',
  'nl',
  'pwd',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'tr',
  'tree',
  'uname',
  'uniq',
  'wc',
  'which',
])

const POWERSHELL_READONLY_COMMANDS = new Set([
  'cat',
  'dir',
  'findstr',
  'format-list',
  'format-table',
  'gc',
  'gci',
  'get-childitem',
  'get-command',
  'get-content',
  'get-item',
  'get-location',
  'git',
  'measure-object',
  'pwd',
  'select-object',
  'select-string',
  'sls',
  'sort-object',
  'test-path',
  'where-object',
])

const READONLY_GIT_SUBCOMMANDS = new Set([
  'blame',
  'branch',
  'describe',
  'diff',
  'grep',
  'log',
  'ls-files',
  'remote',
  'rev-list',
  'rev-parse',
  'show',
  'status',
  'tag',
])

const fail = (reason: string): BashCommandSafety => ({
  readonly: false,
  reason,
})

const hasWriteRedirection = (command: string): boolean => {
  return /(^|[^<])(?:\d?>|&>|>\||\d?>>)/.test(command)
}

const splitCommandSegments = (command: string): string[] | null => {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    const next = command[i + 1]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      current += ch
      escaped = true
      continue
    }

    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }

    if (ch === ';' || ch === '|') {
      if (ch === '|' && next === '|') {
        i++
      }
      segments.push(current.trim())
      current = ''
      continue
    }

    if (ch === '&' && next === '&') {
      i++
      segments.push(current.trim())
      current = ''
      continue
    }

    if (ch === '&') {
      return null
    }

    current += ch
  }

  if (quote) {
    return null
  }

  segments.push(current.trim())
  return segments.filter((segment) => segment.length > 0)
}

const parseWords = (segment: string): string[] | null => {
  const words: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]

    if (escaped) {
      current += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      escaped = true
      continue
    }

    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }

    if (/\s/.test(ch)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }

    current += ch
  }

  if (quote) return null
  if (current) words.push(current)
  return words
}

const stripCommandDecorators = (words: string[]): string[] => {
  let index = 0
  while (index < words.length) {
    const word = words[index]
    if (word === 'command' || word === 'builtin') {
      index++
      continue
    }
    if (word === 'env') {
      index++
      while (
        index < words.length &&
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])
      ) {
        index++
      }
      continue
    }
    break
  }
  return words.slice(index)
}

const isReadonlyGit = (words: string[]): boolean => {
  const subcommand = words
    .slice(1)
    .find(
      (word) => !word.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word),
    )
  if (!subcommand) {
    return false
  }
  if (!READONLY_GIT_SUBCOMMANDS.has(subcommand.toLowerCase())) {
    return false
  }
  if (subcommand.toLowerCase() === 'branch') {
    return words.slice(2).every((word) => word.startsWith('-'))
  }
  if (subcommand.toLowerCase() === 'tag') {
    return words.slice(2).every((word) => word === '-l' || word === '--list')
  }
  if (subcommand.toLowerCase() === 'remote') {
    return words.slice(2).every((word) => word === '-v' || word === '--verbose')
  }
  return true
}

const isReadonlyPosixSegment = (segment: string): BashCommandSafety => {
  const words = parseWords(segment)
  if (!words || words.length === 0) {
    return fail('Could not parse command segment.')
  }

  const commandWords = stripCommandDecorators(words)
  const command = commandWords[0]?.toLowerCase()
  if (!command || !POSIX_READONLY_COMMANDS.has(command)) {
    return fail(
      `Command "${command ?? '(empty)'}" is not in the read-only allowlist.`,
    )
  }

  if (command === 'git' && !isReadonlyGit(commandWords)) {
    return fail('Git subcommand is not read-only.')
  }
  if (
    command === 'find' &&
    commandWords.some((word) =>
      ['-delete', '-exec', '-execdir', '-ok'].includes(word),
    )
  ) {
    return fail('find uses a mutating action.')
  }
  if (
    command === 'sed' &&
    commandWords.some((word) => word === '-i' || word.startsWith('-i'))
  ) {
    return fail('sed in-place editing is not read-only.')
  }

  return { readonly: true }
}

const isReadonlyPowerShellSegment = (segment: string): BashCommandSafety => {
  const words = parseWords(segment)
  if (!words || words.length === 0) {
    return fail('Could not parse command segment.')
  }

  const command = words[0].toLowerCase()
  if (!POWERSHELL_READONLY_COMMANDS.has(command)) {
    return fail(
      `Command "${command}" is not in the PowerShell read-only allowlist.`,
    )
  }

  if (command === 'git' && !isReadonlyGit(words)) {
    return fail('Git subcommand is not read-only.')
  }

  return { readonly: true }
}

export const classifyBashCommandSafety = (
  command: string | undefined,
  flavor: BashCommandFlavor,
): BashCommandSafety => {
  const trimmed = command?.trim() ?? ''
  if (!trimmed) {
    return fail('Command is empty.')
  }
  if (/[\r\n]/.test(trimmed)) {
    return fail('Multiline commands require approval.')
  }
  if (trimmed.includes('<<')) {
    return fail('Here-doc commands require approval.')
  }
  if (trimmed.includes('$(') || trimmed.includes('`')) {
    return fail('Command substitution requires approval.')
  }
  if (hasWriteRedirection(trimmed)) {
    return fail('Write redirection requires approval.')
  }

  const segments = splitCommandSegments(trimmed)
  if (!segments || segments.length === 0) {
    return fail('Could not split command into safe segments.')
  }

  for (const segment of segments) {
    const result =
      flavor === 'powershell'
        ? isReadonlyPowerShellSegment(segment)
        : isReadonlyPosixSegment(segment)
    if (!result.readonly) return result
  }

  return { readonly: true }
}
