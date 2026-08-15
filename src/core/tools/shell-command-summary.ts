import { truncateText } from './chat-summary-support'

/**
 * Shell-command summarizer shared by `bash` and `terminal_command` — the
 * only two tools whose chat-surface summary is "a short, readable form of
 * the command line". Ported verbatim from the private implementation of the
 * same name in `ToolMessage.tsx` (pre-D8); see that file's git history for
 * the original single-copy version this was split out of.
 */

const SHELL_COMMAND_SUMMARY_MAX_CHARS = 80
const SHELL_COMMAND_SUMMARY_SIMPLE_MAX_CHARS = 48
const SHELL_COMMAND_SUMMARY_MAX_NAMES = 5
const SHELL_COMMAND_KEYWORDS = new Set([
  'case',
  'do',
  'done',
  'elif',
  'else',
  'esac',
  'fi',
  'for',
  'function',
  'if',
  'in',
  'select',
  'then',
  'until',
  'while',
])
const SHELL_COMMAND_CONTROL_HEADS = new Set([
  'case',
  'for',
  'function',
  'if',
  'select',
  'until',
  'while',
])
const SHELL_COMMAND_WRAPPERS = new Set([
  'builtin',
  'command',
  'env',
  'exec',
  'nohup',
  'sudo',
  'time',
])

export const summarizeShellCommand = (
  command: string,
  options: { streaming: boolean },
): string | undefined => {
  const preview = command.trim().replace(/\s+/g, ' ')
  if (!preview) return undefined

  if (
    !options.streaming &&
    preview.length <= SHELL_COMMAND_SUMMARY_SIMPLE_MAX_CHARS
  ) {
    return preview
  }

  const simplePreview = summarizeSimpleShellCommand(command)
  if (!options.streaming && simplePreview) {
    return simplePreview
  }

  const commandNames = extractShellCommandNames(command)
  if (commandNames.length === 0) {
    return truncateText(preview, SHELL_COMMAND_SUMMARY_MAX_CHARS)
  }

  const visibleNames = commandNames.slice(0, SHELL_COMMAND_SUMMARY_MAX_NAMES)
  const hiddenCount = commandNames.length - visibleNames.length
  return `${visibleNames.join(', ')}${hiddenCount > 0 ? ` +${hiddenCount}` : ''}`
}

const summarizeSimpleShellCommand = (command: string): string | undefined => {
  const preview = command.trim().replace(/\s+/g, ' ')
  if (!preview || /[;&|<>(){}\n]/.test(command)) {
    return undefined
  }

  const rawWords = preview
    .split(/\s+/)
    .map((word) => word.replace(/^['"]+|['",]+$/g, ''))
    .filter(Boolean)

  let commandIndex = -1
  for (let i = 0; i < rawWords.length; i++) {
    const word = rawWords[i]
    if (SHELL_COMMAND_KEYWORDS.has(word)) continue
    if (SHELL_COMMAND_WRAPPERS.has(word)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (word.startsWith('-') || word.startsWith('$')) continue
    if (!/^[A-Za-z0-9_.:/-]+$/.test(word)) continue
    commandIndex = i
    break
  }

  if (commandIndex < 0) {
    return undefined
  }

  const words = [...rawWords]
  words[commandIndex] =
    words[commandIndex].split('/').pop() ?? words[commandIndex]
  return truncateText(
    words.slice(commandIndex).join(' '),
    SHELL_COMMAND_SUMMARY_MAX_CHARS,
  )
}

const extractShellCommandNames = (command: string): string[] => {
  const names: string[] = []
  const seen = new Set<string>()
  const segments = command.replace(/\$\(/g, ';').split(/[;&|(){}\n]+/)

  for (const segment of segments) {
    const name = extractCommandNameFromShellSegment(segment)
    if (!name || seen.has(name)) continue
    seen.add(name)
    names.push(name)
  }

  return names
}

const extractCommandNameFromShellSegment = (
  segment: string,
): string | undefined => {
  const words = segment
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^['"]+|['",]+$/g, ''))
    .filter(Boolean)

  if (SHELL_COMMAND_CONTROL_HEADS.has(words[0])) {
    return undefined
  }

  for (const word of words) {
    if (SHELL_COMMAND_KEYWORDS.has(word)) continue
    if (SHELL_COMMAND_WRAPPERS.has(word)) continue
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue
    if (word.startsWith('-') || word.startsWith('$')) continue
    if (!/^[A-Za-z0-9_.:/-]+$/.test(word)) continue
    const basename = word.split('/').pop() ?? word
    return basename
  }

  return undefined
}
