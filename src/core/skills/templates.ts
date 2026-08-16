import { DEFAULT_YOLO_BASE_DIR, YOLO_SKILLS_SUBDIR } from '../paths/yoloPaths'

export const YOLO_SKILLS_DIR = `${DEFAULT_YOLO_BASE_DIR}/${YOLO_SKILLS_SUBDIR}`

export const getSkillsPathAwareTemplate = (
  template: string,
  skillsDir: string = YOLO_SKILLS_DIR,
): string => {
  return template.split(YOLO_SKILLS_DIR).join(skillsDir)
}

export const YOLO_SKILLS_INDEX_TEMPLATE = `# YOLO Skills

Store YOLO skills here in either supported form.

- Simple skill: \`YOLO/skills/<readable-name>.md\`
- Skill package with resources: \`YOLO/skills/<folder>/SKILL.md\`
- Required frontmatter: a non-empty \`name\`; \`description\` and \`mode\` (\`lazy\` | \`always\`) are optional.
- Keep supporting \`scripts/\`, \`references/\`, \`assets/\`, and other resources inside the package folder.
- Preserve existing filenames and package folder names when editing skills.
`
