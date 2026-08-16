import snippetCreatorSource from './builtin/snippet-creator/SKILL.md'
import {
  assertNoDuplicateBuiltinSkillNames,
  getBuiltinLiteSkillByName,
  listBuiltinLiteSkills,
} from './builtinSkills'
import { parseFrontmatter } from './skillValidation'

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

  it('renders snippet creator content with the configured snippets path', () => {
    const builtin = getBuiltinLiteSkillByName({
      name: 'snippet-creator',
      snippetsPath: '99-Assets/YOLO/snippets.md',
    })

    expect(builtin).not.toBeNull()
    expect(builtin?.content).toContain('99-Assets/YOLO/snippets.md')
    expect(builtin?.content).not.toContain('Read `YOLO/snippets.md`')
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

  // Metadata lives in each `SKILL.md` frontmatter and nowhere else. These
  // assertions fail the moment someone reintroduces a hand-written copy that
  // can drift from the file the model actually reads.
  it('derives builtin metadata from each SKILL.md frontmatter', () => {
    const skills = listBuiltinLiteSkills()

    expect(skills.map((skill) => skill.name)).toEqual([
      'obsidian-output-format',
      'skill-creator',
      'snippet-creator',
      'obsidian-cli',
    ])

    for (const skill of skills) {
      const frontmatter = parseFrontmatter(skill.content)
      expect(frontmatter).not.toBeNull()
      expect(frontmatter?.name).toBe(skill.name)
      expect(frontmatter?.description).toBe(skill.description)
      expect(frontmatter?.mode).toBe(skill.mode)
      expect(skill.path).toBe(`builtin://skills/${skill.name}.md`)
    }
  })

  // Names come from frontmatter, so nothing structural stops two SKILL.md
  // files from claiming one — and every lookup is a `find` that would serve
  // the first while the other builtin quietly disappeared.
  it('rejects two builtins claiming the same name', () => {
    expect(() =>
      assertNoDuplicateBuiltinSkillNames([
        'skill-creator',
        'obsidian-cli',
        'skill-creator',
      ]),
    ).toThrow('Duplicate builtin skill name: "skill-creator"')
  })

  it('accepts the real builtin name set', () => {
    expect(() =>
      assertNoDuplicateBuiltinSkillNames(
        listBuiltinLiteSkills().map((skill) => skill.name),
      ),
    ).not.toThrow()
  })

  it('reads the snippet creator description straight from its SKILL.md', () => {
    const frontmatter = parseFrontmatter(snippetCreatorSource)
    const builtin = getBuiltinLiteSkillByName({ name: 'snippet-creator' })

    expect(builtin?.description).toBe(frontmatter?.description)
    expect(builtin?.mode).toBe('lazy')
  })
})
