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
    expect(builtin?.content).not.toContain(
      'fs_write { path: "YOLO/skills/<skill-name>.md"',
    )
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
})
