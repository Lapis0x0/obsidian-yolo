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

import { ChatSelectedSkill } from '../../../../../types/chat'

export const SKILL_NODE_TYPE = 'skill-mention'
export const SKILL_NODE_ATTRIBUTE = 'data-lexical-skill'
export const SKILL_NODE_NAME_ATTRIBUTE = 'data-lexical-skill-name'
export const SKILL_NODE_SKILL_ATTRIBUTE = 'data-lexical-skill-payload'

export type SerializedSkillNode = Spread<
  {
    skillName: string
    skill: ChatSelectedSkill
  },
  SerializedTextNode
>

function $convertSkillElement(
  domNode: HTMLElement,
): DOMConversionOutput | null {
  const textContent = domNode.textContent
  const skillName =
    domNode.getAttribute(SKILL_NODE_NAME_ATTRIBUTE) ?? textContent ?? ''
  const skill = JSON.parse(
    domNode.getAttribute(SKILL_NODE_SKILL_ATTRIBUTE) ?? '{}',
  ) as ChatSelectedSkill

  if (textContent !== null) {
    return {
      node: $createSkillNode(skillName, skill),
    }
  }

  return null
}

export class SkillNode extends TextNode {
  __skillName: string
  __skill: ChatSelectedSkill

  static getType(): string {
    return SKILL_NODE_TYPE
  }

  static clone(node: SkillNode): SkillNode {
    return new SkillNode(node.__skillName, node.__skill, node.__key)
  }

  static importJSON(serializedNode: SerializedSkillNode): SkillNode {
    const node = $createSkillNode(
      serializedNode.skillName,
      serializedNode.skill,
    )
    node.setTextContent(serializedNode.skillName)
    node.setFormat(serializedNode.format)
    node.setDetail(serializedNode.detail)
    node.setMode(serializedNode.mode)
    node.setStyle(serializedNode.style)
    return node
  }

  constructor(skillName: string, skill: ChatSelectedSkill, key?: NodeKey) {
    super(skillName, key)
    this.__skillName = skillName
    this.__skill = skill
  }

  exportJSON(): SerializedSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      skill: this.__skill,
      type: SKILL_NODE_TYPE,
      version: 1,
    }
  }

  createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config)
    dom.className = 'mention smtcmp-skill-mention'
    dom.setAttribute('contenteditable', 'false')
    return dom
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement('span')
    element.setAttribute(SKILL_NODE_ATTRIBUTE, 'true')
    element.setAttribute(SKILL_NODE_NAME_ATTRIBUTE, this.__skillName)
    element.setAttribute(
      SKILL_NODE_SKILL_ATTRIBUTE,
      JSON.stringify(this.__skill),
    )
    element.textContent = this.__text
    return { element }
  }

  static importDOM(): DOMConversionMap | null {
    return {
      span: (domNode: HTMLElement) => {
        if (
          !domNode.hasAttribute(SKILL_NODE_ATTRIBUTE) ||
          !domNode.hasAttribute(SKILL_NODE_NAME_ATTRIBUTE) ||
          !domNode.hasAttribute(SKILL_NODE_SKILL_ATTRIBUTE)
        ) {
          return null
        }
        return {
          conversion: $convertSkillElement,
          priority: 1,
        }
      },
    }
  }

  isTextEntity(): true {
    return true
  }

  canInsertTextBefore(): boolean {
    return true
  }

  canInsertTextAfter(): boolean {
    return true
  }

  getSkill(): ChatSelectedSkill {
    return this.__skill
  }
}

export function $createSkillNode(
  skillName: string,
  skill: ChatSelectedSkill,
): SkillNode {
  const skillNode = new SkillNode(skillName, skill)
  skillNode.setMode('token').toggleDirectionless()
  return $applyNodeReplacement(skillNode)
}

export function $isSkillNode(
  node: LexicalNode | null | undefined,
): node is SkillNode {
  return node instanceof SkillNode
}
