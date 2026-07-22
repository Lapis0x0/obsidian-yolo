/* eslint-disable import/no-extraneous-dependencies -- Parser dependencies are supplied by the first-party module build workspace. */
import { parseFragment } from 'parse5'

import type { AnkiMediaReference } from './types'

type Node = {
  nodeName: string
  value?: string
  tagName?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Node[]
}

const BLOCKED = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'template',
])

const safeMediaName = (raw: string): string | null => {
  const name = raw.trim().replace(/^['"]|['"]$/g, '')
  return !name ||
    name.includes('\0') ||
    name.includes('..') ||
    /[\\/]/.test(name) ||
    /^[a-z][a-z\d+.-]*:/i.test(name)
    ? null
    : name
}

const safeLink = (raw: string): string | null => {
  const value = raw.trim()
  if (!value || [...value].some((character) => character.charCodeAt(0) < 32))
    return null
  if (/^(?:https?:|mailto:)/i.test(value) || /^(?:#|\/)/.test(value))
    return value.replace(/[()\s]/g, (character) =>
      encodeURIComponent(character),
    )
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? null : value
}

const attr = (node: Node, name: string): string =>
  node.attrs?.find((item) => item.name.toLowerCase() === name)?.value ?? ''

export const htmlToMarkdown = (
  html: string,
): { markdown: string; media: AnkiMediaReference[] } => {
  const withSound = html.replace(
    /\[sound:([^\]]+)]/gi,
    (_match, raw: string) => {
      const filename = safeMediaName(raw)
      return filename
        ? ` {{anki-media:audio:${encodeURIComponent(filename)}}} `
        : ''
    },
  )
  const root = parseFragment(withSound) as unknown as Node

  const walk = (
    node: Node,
    listDepth = 0,
    listKind: 'ul' | 'ol' = 'ul',
  ): string => {
    if (node.nodeName === '#text') return node.value ?? ''
    const tag = node.tagName?.toLowerCase()
    if (tag && BLOCKED.has(tag)) return ''
    if (tag === 'img') {
      const filename = safeMediaName(attr(node, 'src'))
      return filename
        ? `{{anki-media:image:${encodeURIComponent(filename)}}}`
        : ''
    }
    const nextListKind = tag === 'ol' ? 'ol' : tag === 'ul' ? 'ul' : listKind
    const children = (node.childNodes ?? [])
      .map((child) =>
        walk(
          child,
          listDepth + (tag === 'ul' || tag === 'ol' ? 1 : 0),
          nextListKind,
        ),
      )
      .join('')
    if (!tag) return children
    if (tag === 'br') return '\n'
    if (tag === 'hr') return '\n\n---\n\n'
    if (tag === 'b' || tag === 'strong')
      return children ? `**${children}**` : ''
    if (tag === 'i' || tag === 'em') return children ? `*${children}*` : ''
    if (tag === 'code') return `\`${children.replace(/`/g, '\\`')}\``
    if (tag === 'pre')
      return `\n\n\`\`\`\n${children.replace(/^`|`$/g, '')}\n\`\`\`\n\n`
    if (tag === 'a') {
      const href = safeLink(attr(node, 'href'))
      return href && children ? `[${children}](${href})` : children
    }
    if (tag === 'blockquote')
      return `\n\n${children
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`
    if (tag === 'li') {
      const marker = listKind === 'ol' ? '1. ' : '- '
      return `${'  '.repeat(Math.max(0, listDepth - 1))}${marker}${children.trim()}\n`
    }
    if (tag === 'ul' || tag === 'ol') return `\n${children}\n`
    if (tag === 'th' || tag === 'td')
      return ` ${children.trim().replace(/\|/g, '\\|')} |`
    if (tag === 'tr') return `|${children}\n`
    if (tag === 'table') {
      const table = children.trim()
      const first = table.split('\n')[0] ?? ''
      const columns = Math.max(1, (first.match(/\|/g) ?? []).length - 1)
      return `\n\n${first}\n|${' --- |'.repeat(columns)}\n${table.split('\n').slice(1).join('\n')}\n\n`
    }
    if (
      [
        'p',
        'div',
        'section',
        'article',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
      ].includes(tag)
    )
      return `\n\n${children}\n\n`
    return children
  }

  const markdown = walk(root)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const media = [
    ...markdown.matchAll(/{{anki-media:(image|audio):([^}]+)}}/g),
  ].map(
    (match): AnkiMediaReference => ({
      kind: match[1] as 'image' | 'audio',
      filename: decodeURIComponent(match[2]),
      placeholder: match[0],
    }),
  )
  return { markdown, media }
}
