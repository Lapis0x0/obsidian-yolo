import type { ChatSelectedSkill } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import type { Mentionable } from '../../types/mentionable'

import type { CliRuntimeId } from './types'

export type BuildCliTurnContentInput = {
  runtimeId: CliRuntimeId
  text: string
  mentionables: readonly Mentionable[]
  selectedSkills?: readonly ChatSelectedSkill[]
  timeContext?: string
  environmentContext?: readonly ContentPart[]
}

const section = (label: string, body: string): string =>
  `<${label}>\n${body}\n</${label}>`

const namedContent = (name: string, content: string): string =>
  `${JSON.stringify(name)}\n${content}`

export const CLI_ENVIRONMENT_CONTEXT_OPEN = '<yolo_environment_context>'
export const CLI_ENVIRONMENT_CONTEXT_CLOSE = '</yolo_environment_context>'

const locateCliEnvironmentContext = (
  text: string,
): { start: number; visiblePrefix: string } | null => {
  const start = text.search(/\S/u)
  if (start < 0) return null
  if (text.startsWith(CLI_ENVIRONMENT_CONTEXT_OPEN, start)) {
    return { start, visiblePrefix: '' }
  }
  const command = text.slice(start).match(/^\/[^\s]+\s+/u)?.[0]
  if (!command) return null
  const environmentStart = start + command.length
  return text.startsWith(CLI_ENVIRONMENT_CONTEXT_OPEN, environmentStart)
    ? { start: environmentStart, visiblePrefix: command.trimEnd() }
    : null
}

const joinVisiblePrefix = (prefix: string, text: string): string =>
  prefix ? `${prefix}${text ? ` ${text}` : ''}` : text

export const stripCliEnvironmentContextFromText = (text: string): string => {
  const located = locateCliEnvironmentContext(text)
  if (!located) return text
  const closeIndex = text.indexOf(
    CLI_ENVIRONMENT_CONTEXT_CLOSE,
    located.start + CLI_ENVIRONMENT_CONTEXT_OPEN.length,
  )
  if (closeIndex < 0) return text
  const visibleText = text
    .slice(closeIndex + CLI_ENVIRONMENT_CONTEXT_CLOSE.length)
    .replace(/^(?:[\t ]*\r?\n){0,2}/u, '')
  return joinVisiblePrefix(located.visiblePrefix, visibleText)
}

export const stripCliEnvironmentContext = (
  content: string | ContentPart[],
): string | ContentPart[] => {
  if (typeof content === 'string') {
    return stripCliEnvironmentContextFromText(content)
  }
  const first = content[0]
  if (first?.type !== 'text') return content
  const located = locateCliEnvironmentContext(first.text)
  if (!located) return content

  for (let index = 0; index < content.length; index += 1) {
    const part = content[index]
    if (part?.type !== 'text') continue
    const closeIndex = part.text.indexOf(CLI_ENVIRONMENT_CONTEXT_CLOSE)
    if (closeIndex < 0) continue
    const visibleText = part.text
      .slice(closeIndex + CLI_ENVIRONMENT_CONTEXT_CLOSE.length)
      .replace(/^(?:[\t ]*\r?\n){0,2}/u, '')
    const prefixedVisibleText = joinVisiblePrefix(
      located.visiblePrefix,
      visibleText,
    )
    return [
      ...(prefixedVisibleText
        ? [{ type: 'text' as const, text: prefixedVisibleText }]
        : []),
      ...content.slice(index + 1),
    ]
  }
  return content
}

const describeMentionable = (
  mentionable: Exclude<Mentionable, { type: 'image' | 'pdf' | 'model' }>,
): string => {
  switch (mentionable.type) {
    case 'file':
      return `<vault_file path=${JSON.stringify(mentionable.file.path)} />`
    case 'folder':
      return `<vault_folder path=${JSON.stringify(mentionable.folder.path)} />`
    // Absolute host path, outside the vault cwd — the agent reaches it with
    // its own filesystem tools.
    case 'local-folder':
      return `<local_folder path=${JSON.stringify(mentionable.path)} />`
    case 'block':
      return section(
        'vault_selection',
        `path=${JSON.stringify(mentionable.file.path)} lines=${mentionable.startLine}-${mentionable.endLine}\n${mentionable.content}`,
      )
    case 'assistant-quote':
      return section(
        'assistant_quote',
        `${mentionable.annotationNumber !== undefined ? `<annotation_number>${mentionable.annotationNumber}</annotation_number>\n` : ''}<quote>\n${mentionable.content}\n</quote>${mentionable.comment?.trim() ? `\n<comment>\n${mentionable.comment.trim()}\n</comment>` : ''}`,
      )
    case 'url':
      return `<url>${mentionable.url}</url>`
    case 'web-selection':
      return section(
        'web_selection',
        `title=${JSON.stringify(mentionable.title)} url=${JSON.stringify(mentionable.url)}\n${mentionable.content}`,
      )
    case 'office':
      return section(
        'office_attachment',
        namedContent(mentionable.name, mentionable.extractedText),
      )
    case 'text-attachment':
      return section(
        'text_attachment',
        namedContent(mentionable.name, mentionable.content),
      )
  }
}

const buildText = ({
  text,
  references,
}: {
  text: string
  references: string[]
}): string => {
  const parts: string[] = []
  if (references.length > 0) {
    parts.push(section('references', references.join('\n\n')))
  }
  if (text.trim()) parts.push(text)
  return parts.join('\n\n')
}

const buildEnvironmentParts = (
  timeContext: string | undefined,
  environmentContext: readonly ContentPart[],
): ContentPart[] => {
  if (!timeContext && environmentContext.length === 0) return []

  const parts: ContentPart[] = []
  let text = CLI_ENVIRONMENT_CONTEXT_OPEN
  if (timeContext) {
    text += `\n<current_time>${timeContext}</current_time>`
  }

  for (const part of environmentContext) {
    if (part.type === 'text') {
      text += `\n\n${part.text}`
      continue
    }
    if (text) parts.push({ type: 'text', text })
    parts.push(part)
    text = ''
  }

  text += `${text ? '\n' : ''}${CLI_ENVIRONMENT_CONTEXT_CLOSE}`
  parts.push({ type: 'text', text })
  return parts
}

/**
 * Encode one user-authored turn for a provider-native CLI runtime. This is
 * deliberately independent from RequestContextBuilder: CLI agents work from
 * the vault cwd and receive only explicit user references/attachments here.
 */
export const buildCliTurnContent = ({
  runtimeId,
  text,
  mentionables,
  selectedSkills = [],
  timeContext,
  environmentContext = [],
}: BuildCliTurnContentInput): string | ContentPart[] => {
  const references: string[] = []
  const binaryParts: ContentPart[] = []

  for (const mentionable of mentionables) {
    if (mentionable.type === 'model') {
      throw new Error('CLI runtime does not support model mentions.')
    }
    if (mentionable.type === 'image') {
      binaryParts.push({
        type: 'image_url',
        image_url: {
          url: mentionable.data,
        },
      })
      continue
    }
    if (mentionable.type === 'pdf') {
      if (runtimeId === 'claude-code' && mentionable.rawData) {
        binaryParts.push({
          type: 'document',
          mediaType: 'application/pdf',
          name: mentionable.name,
          data: mentionable.rawData,
          ...(mentionable.pageCount !== undefined
            ? { pageCount: mentionable.pageCount }
            : {}),
        })
        continue
      }
      if (mentionable.data) {
        references.push(
          section(
            'pdf_attachment',
            namedContent(mentionable.name, mentionable.data),
          ),
        )
        continue
      }
      throw new Error(
        runtimeId === 'codex'
          ? 'Codex CLI runtime does not support PDF attachments without extracted text.'
          : 'The PDF attachment has no readable content.',
      )
    }
    references.push(describeMentionable(mentionable))
  }

  const textPart = buildText({
    text,
    references,
  })
  const selectedClaudeSkill =
    runtimeId === 'claude-code' ? selectedSkills.at(-1) : undefined
  const environmentParts = buildEnvironmentParts(
    timeContext,
    environmentContext,
  )
  if (binaryParts.length === 0 && environmentParts.length === 0) {
    return selectedClaudeSkill
      ? `/${selectedClaudeSkill.name}${textPart ? ` ${textPart}` : ''}`
      : textPart
  }
  const contentParts: ContentPart[] = [
    ...environmentParts,
    ...(textPart ? [{ type: 'text' as const, text: textPart }] : []),
    ...binaryParts,
  ]
  if (selectedClaudeSkill) {
    const command = `/${selectedClaudeSkill.name}`
    const firstPart = contentParts[0]
    if (firstPart?.type === 'text') {
      contentParts[0] = {
        type: 'text',
        text: `${command}${firstPart.text ? ` ${firstPart.text}` : ''}`,
      }
    } else {
      contentParts.unshift({ type: 'text', text: command })
    }
  }
  return contentParts.every((part) => part.type === 'text')
    ? contentParts.map((part) => part.text).join('\n\n')
    : contentParts
}
