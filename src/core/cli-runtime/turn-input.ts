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

const describeMentionable = (
  mentionable: Exclude<Mentionable, { type: 'image' | 'pdf' | 'model' }>,
): string => {
  switch (mentionable.type) {
    case 'file':
      return `<vault_file path=${JSON.stringify(mentionable.file.path)} />`
    case 'folder':
      return `<vault_folder path=${JSON.stringify(mentionable.folder.path)} />`
    case 'block':
      return section(
        'vault_selection',
        `path=${JSON.stringify(mentionable.file.path)} lines=${mentionable.startLine}-${mentionable.endLine}\n${mentionable.content}`,
      )
    case 'assistant-quote':
      return section('assistant_quote', mentionable.content)
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
  timeContext,
}: {
  text: string
  references: string[]
  timeContext?: string
}): string => {
  const parts: string[] = []
  if (timeContext) parts.push(`<current_time>${timeContext}</current_time>`)
  if (references.length > 0) {
    parts.push(section('references', references.join('\n\n')))
  }
  if (text.trim()) parts.push(text)
  return parts.join('\n\n')
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
    timeContext,
  })
  const selectedClaudeSkill =
    runtimeId === 'claude-code' ? selectedSkills.at(-1) : undefined
  const nativeTextPart = selectedClaudeSkill
    ? `/${selectedClaudeSkill.name}${textPart ? ` ${textPart}` : ''}`
    : textPart
  if (binaryParts.length === 0 && environmentContext.length === 0) {
    return nativeTextPart
  }
  return [
    ...(nativeTextPart
      ? [{ type: 'text' as const, text: nativeTextPart }]
      : []),
    ...environmentContext,
    ...binaryParts,
  ]
}
