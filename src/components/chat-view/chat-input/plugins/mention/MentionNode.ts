/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license.
 * Original source: https://github.com/facebook/lexical
 *
 * Modified from the original code
 */

import {
  $applyNodeReplacement,
  DOMConversionMap,
  DOMConversionOutput,
  DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
  TextNode,
} from 'lexical'

import { SerializedMentionable } from '../../../../../types/mentionable'

export const MENTION_NODE_TYPE = 'mention'
export const MENTION_NODE_ATTRIBUTE = 'data-lexical-mention'
export const MENTION_NODE_MENTION_NAME_ATTRIBUTE = 'data-lexical-mention-name'
export const MENTION_NODE_MENTIONABLE_ATTRIBUTE = 'data-lexical-mentionable'

const MAX_MENTION_NAME_LENGTH = 32
const MENTION_ELLIPSIS = '…'

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  )
}

function getVisualWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    width += codePoint && isWideCodePoint(codePoint) ? 2 : 1
  }
  return width
}

function truncateByWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  let width = 0
  let result = ''
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    const charWidth = codePoint && isWideCodePoint(codePoint) ? 2 : 1
    if (width + charWidth > maxWidth) break
    result += char
    width += charWidth
  }
  return result
}

function getDisplayMentionName(mentionName: string): string {
  if (getVisualWidth(mentionName) <= MAX_MENTION_NAME_LENGTH) {
    return mentionName
  }
  if (MAX_MENTION_NAME_LENGTH <= 1) {
    return MENTION_ELLIPSIS
  }
  const suffixMatch = mentionName.match(/\s\([0-9]+\s[^)]+\)$/)
  if (suffixMatch) {
    const suffix = suffixMatch[0]
    const suffixWidth = getVisualWidth(suffix)
    if (suffixWidth >= MAX_MENTION_NAME_LENGTH) {
      return `${truncateByWidth(suffix, MAX_MENTION_NAME_LENGTH - 1)}${MENTION_ELLIPSIS}`
    }
    const prefixText = mentionName.slice(0, mentionName.length - suffix.length)
    const prefixLength = MAX_MENTION_NAME_LENGTH - 1 - suffixWidth
    const prefix = truncateByWidth(prefixText, prefixLength)
    return `${prefix}${MENTION_ELLIPSIS}${suffix}`
  }
  return `${truncateByWidth(mentionName, MAX_MENTION_NAME_LENGTH - 1)}${MENTION_ELLIPSIS}`
}

export type SerializedMentionNode = Spread<
  {
    mentionName: string
    mentionable: SerializedMentionable
  },
  SerializedTextNode
>

function $convertMentionElement(
  domNode: HTMLElement,
): DOMConversionOutput | null {
  const textContent = domNode.textContent
  const mentionName =
    domNode.getAttribute(MENTION_NODE_MENTION_NAME_ATTRIBUTE) ??
    domNode.textContent ??
    ''
  const mentionable = JSON.parse(
    domNode.getAttribute(MENTION_NODE_MENTIONABLE_ATTRIBUTE) ?? '{}',
  )

  if (textContent !== null) {
    const node = $createMentionNode(
      mentionName,
      mentionable as SerializedMentionable,
    )
    return {
      node,
    }
  }

  return null
}

export class MentionNode extends TextNode {
  __mentionName: string
  __mentionable: SerializedMentionable

  static getType(): string {
    return MENTION_NODE_TYPE
  }

  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__mentionName, node.__mentionable, node.__key)
  }
  static importJSON(serializedNode: SerializedMentionNode): MentionNode {
    const node = $createMentionNode(
      serializedNode.mentionName,
      serializedNode.mentionable,
    )
    node.setTextContent(`@${getDisplayMentionName(serializedNode.mentionName)}`)
    node.setFormat(serializedNode.format)
    node.setDetail(serializedNode.detail)
    node.setMode(serializedNode.mode)
    node.setStyle(serializedNode.style)
    return node
  }

  constructor(
    mentionName: string,
    mentionable: SerializedMentionable,
    key?: NodeKey,
  ) {
    super(`@${getDisplayMentionName(mentionName)}`, key)
    this.__mentionName = mentionName
    this.__mentionable = mentionable
  }

  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      mentionName: this.__mentionName,
      mentionable: this.__mentionable,
      type: MENTION_NODE_TYPE,
      version: 1,
    }
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    dom.className = MENTION_NODE_TYPE
    dom.setAttribute('contenteditable', 'false')
    return dom
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span')
    element.setAttribute(MENTION_NODE_ATTRIBUTE, 'true')
    element.setAttribute(
      MENTION_NODE_MENTION_NAME_ATTRIBUTE,
      this.__mentionName,
    )
    element.setAttribute(
      MENTION_NODE_MENTIONABLE_ATTRIBUTE,
      JSON.stringify(this.__mentionable),
    )
    element.textContent = this.__text
    return { element }
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (
          !domNode.hasAttribute(MENTION_NODE_ATTRIBUTE) ||
          !domNode.hasAttribute(MENTION_NODE_MENTION_NAME_ATTRIBUTE) ||
          !domNode.hasAttribute(MENTION_NODE_MENTIONABLE_ATTRIBUTE)
        ) {
          return null
        }
        return {
          conversion: $convertMentionElement,
          priority: 1,
        }
      },
    }
  }

  isTextEntity(): true {
    return true
  }

  canInsertTextBefore(): boolean {
    return false
  }

  canInsertTextAfter(): boolean {
    return false
  }

  getMentionable(): SerializedMentionable {
    return this.__mentionable
  }
}

export function $createMentionNode(
  mentionName: string,
  mentionable: SerializedMentionable,
): MentionNode {
  const mentionNode = new MentionNode(mentionName, mentionable)
  mentionNode.setMode('token').toggleDirectionless()
  return $applyNodeReplacement(mentionNode)
}

export function $isMentionNode(
  node: LexicalNode | null | undefined,
): node is MentionNode {
  return node instanceof MentionNode
}
