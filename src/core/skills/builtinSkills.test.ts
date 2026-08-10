import {
  getBuiltinLiteSkillByName,
  listBuiltinLiteSkills,
} from './builtinSkills'

describe('builtin skills', () => {
  it('renders skill creator content with the configured skills directory', () => {
    const builtin = getBuiltinLiteSkillByName({
      name: 'skill-creator',
      skillsDir: '99-Assets/YOLO/skills',
    })

    expect(builtin).not.toBeNull()
    expect(builtin?.content).toContain('99-Assets/YOLO/skills')
    expect(builtin?.content).toContain(
      '99-Assets/YOLO/skills/<readable-name>.md',
    )
    expect(builtin?.content).toContain(
      '99-Assets/YOLO/skills/<folder>/SKILL.md',
    )
    expect(builtin?.content).not.toContain('fs_write { path: "YOLO/skills/')
  })

  it('keeps other builtin skills unchanged when injecting a skills directory', () => {
    const skills = listBuiltinLiteSkills({
      skillsDir: '99-Assets/YOLO/skills',
    })
    const outputFormat = skills.find(
      (skill) => skill.name === 'obsidian-output-format',
    )

    expect(outputFormat).not.toBeUndefined()
    expect(outputFormat?.content).toContain('<yolo_block>')
  })

  it('renders the snippet skill content and description with its current path', () => {
    const builtin = getBuiltinLiteSkillByName({
      name: 'snippet-creator',
      snippetsPath: 'Config/YOLO/snippets.md',
    })

    expect(builtin?.description).toContain('Config/YOLO/snippets.md')
    expect(builtin?.content).toContain('Config/YOLO/snippets.md')
    expect(builtin?.description).not.toContain('`YOLO/snippets.md`')
  })

  it('exposes obsidian-cli as a lazy builtin skill', () => {
    const builtin = getBuiltinLiteSkillByName({ name: 'obsidian-cli' })

    expect(builtin).not.toBeNull()
    expect(builtin?.mode).toBe('lazy')
    expect(builtin?.content).toContain('obsidian-cli')
    expect(builtin?.content).toContain('<resolved-cli> version')
    expect(builtin?.content).toContain(
      '/Applications/Obsidian.app/Contents/MacOS/obsidian',
    )
    expect(builtin?.content).toContain('terminal_command')
  })
})
