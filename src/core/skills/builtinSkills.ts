import {
  YOLO_SNIPPET_CREATOR_TEMPLATE,
  getSnippetsPathAwareTemplate,
} from '../snippets/templates'

import {
  YOLO_OBSIDIAN_CLI_TEMPLATE,
  YOLO_OBSIDIAN_OUTPUT_FORMAT_TEMPLATE,
  YOLO_SKILL_CREATOR_TEMPLATE,
  getSkillsPathAwareTemplate,
} from './templates'

type BuiltinLiteSkill = {
  /** Canonical identifier (kebab-case). Doubles as the human-facing label. */
  name: string
  description: string
  mode: 'always' | 'lazy'
  path: string
  content: string
}

const BUILTIN_SKILLS: BuiltinLiteSkill[] = [
  {
    name: 'obsidian-output-format',
    description:
      'Enforce Obsidian markdown output contract with <yolo_block> tags. Use whenever returning markdown content, proposing markdown edits, or referencing markdown snippets.',
    mode: 'always',
    path: 'builtin://skills/obsidian-output-format.md',
    content: YOLO_OBSIDIAN_OUTPUT_FORMAT_TEMPLATE,
  },
  {
    name: 'skill-creator',
    description:
      'Guide for creating effective YOLO skills. Use when users want to create a new skill, update an existing skill, or improve skill quality within their Obsidian vault. Covers skill design principles, anatomy, and the full creation workflow.',
    mode: 'lazy',
    path: 'builtin://skills/skill-creator.md',
    content: YOLO_SKILL_CREATOR_TEMPLATE,
  },
  {
    name: 'snippet-creator',
    description:
      "Guide for editing `YOLO/snippets.md`, the user's library of chat snippets (short prompts the user inserts via the chat input's `/` menu, e.g. `/translate`, `/review`). Use when the user asks to add, edit, rename, list, or delete a 快捷指令 / chat snippet, or describes a recurring prompt they want as a slash shortcut.",
    mode: 'lazy',
    path: 'builtin://skills/snippet-creator.md',
    content: YOLO_SNIPPET_CREATOR_TEMPLATE,
  },
  {
    name: 'obsidian-cli',
    description:
      'Drive Obsidian via the official CLI through terminal_command. Use when the user asks for Obsidian CLI, or when native fs_* / js_eval tools cannot cover Obsidian-specific operations (backlinks, properties, daily notes, command palette, plugin reload, tasks/tags, version history, etc.).',
    mode: 'lazy',
    path: 'builtin://skills/obsidian-cli.md',
    content: YOLO_OBSIDIAN_CLI_TEMPLATE,
  },
]

const renderBuiltinContent = (
  skill: BuiltinLiteSkill,
  options?: { skillsDir?: string; snippetsPath?: string },
): string => {
  if (skill.name === 'skill-creator') {
    return getSkillsPathAwareTemplate(skill.content, options?.skillsDir)
  }
  if (skill.name === 'snippet-creator') {
    return getSnippetsPathAwareTemplate(skill.content, options?.snippetsPath)
  }
  return skill.content
}

export const listBuiltinLiteSkills = (options?: {
  skillsDir?: string
  snippetsPath?: string
}): BuiltinLiteSkill[] => {
  return BUILTIN_SKILLS.map((skill) => ({
    ...skill,
    content: renderBuiltinContent(skill, options),
  }))
}

export const getBuiltinLiteSkillByName = ({
  name,
  skillsDir,
  snippetsPath,
}: {
  name?: string
  skillsDir?: string
  snippetsPath?: string
}): BuiltinLiteSkill | null => {
  const targetName = name?.trim()
  if (!targetName) {
    return null
  }

  // Case-sensitive exact match — consistent with the vault resolver in
  // liteSkills.ts (trim only, no lowercasing/slugify).
  const matched = BUILTIN_SKILLS.find((skill) => skill.name === targetName)

  if (!matched) {
    return null
  }

  return {
    ...matched,
    content: renderBuiltinContent(matched, { skillsDir, snippetsPath }),
  }
}
