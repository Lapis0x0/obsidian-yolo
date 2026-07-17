import type {
  LearningVaultEntry,
  LearningVaultReadApi,
} from './learningVaultReadApi'
import { scanProject, scanProjects } from './projectScanner'

const file = (name: string, path: string, mtime = 1): LearningVaultEntry => ({
  kind: 'file',
  name,
  path,
  mtime,
})
const folder = (name: string, path: string): LearningVaultEntry => ({
  kind: 'folder',
  name,
  path,
})

function createVault(
  children: Record<string, LearningVaultEntry[]>,
  contents: Record<string, string>,
): LearningVaultReadApi {
  const entries = new Map(
    Object.values(children)
      .flat()
      .concat(folder('learning', 'learning'))
      .map((entry) => [entry.path, entry]),
  )
  return {
    getEntry: (path) => entries.get(path) ?? null,
    listChildren: (path) => children[path] ?? [],
    readText: async (path) => contents[path] ?? '',
    onCreate: () => () => undefined,
    onModify: () => () => undefined,
    onDelete: () => () => undefined,
    onRename: () => () => undefined,
  }
}

describe('projectScanner', () => {
  it('reads fresh Markdown directly and preserves knowledge mtime', async () => {
    const projectPath = 'learning/test'
    const chapterPath = `${projectPath}/01-basics`
    const vault = createVault(
      {
        learning: [folder('test', projectPath)],
        [projectPath]: [
          file('index.md', `${projectPath}/index.md`),
          folder('01-basics', chapterPath),
        ],
        [chapterPath]: [
          file('knowledge.md', `${chapterPath}/knowledge.md`, 42),
        ],
      },
      {
        [`${projectPath}/index.md`]:
          '---\ntopic: Test\ngoal: Scan now\nstatus: building\nchapters:\n  - 01-basics\n---\n',
        [`${chapterPath}/knowledge.md`]:
          '---\ntitle: Basics\n---\n\n## First point <!--kp:abc12345-->\n',
      },
    )

    const project = await scanProject(vault, projectPath)

    expect(project).toMatchObject({
      kind: 'outline',
      id: projectPath,
      chapters: [{ id: chapterPath, title: 'Basics' }],
      knowledgePoints: [
        { id: `${chapterPath}/abc12345`, title: 'First point', mtime: 42 },
      ],
    })
  })

  it('sorts projects and scans card chapters in declared order', async () => {
    const projectPath = 'learning/cards'
    const first = `${projectPath}/first`
    const second = `${projectPath}/second`
    const vault = createVault(
      {
        learning: [
          folder('z-last', 'learning/z-last'),
          folder('cards', projectPath),
        ],
        'learning/z-last': [file('index.md', 'learning/z-last/index.md')],
        [projectPath]: [
          file('index.md', `${projectPath}/index.md`),
          folder('first', first),
          folder('assets', `${projectPath}/assets`),
          folder('second', second),
          folder('ref', `${projectPath}/ref`),
        ],
        [first]: [
          file('index.md', `${first}/index.md`),
          file('cards.md', `${first}/cards.md`),
        ],
        [second]: [
          file('index.md', `${second}/index.md`),
          file('cards.md', `${second}/cards.md`),
        ],
      },
      {
        [`${projectPath}/index.md`]:
          '---\nkind: cards\ntopic: Cards\ngoal: Learn\nchapters:\n  - second\n  - assets\n  - first\n  - ref\n---\n',
        [`${first}/index.md`]: '---\ntitle: First\n---\n',
        [`${first}/cards.md`]: '---\ntitle: First cards\n---\n',
        [`${second}/index.md`]: '---\ntitle: Second\n---\n',
        [`${second}/cards.md`]: '---\ntitle: Second cards\n---\n',
        'learning/z-last/index.md': '---\ntopic: Zed\ngoal: Last\n---\n',
      },
    )

    const result = await scanProjects(vault, 'learning/')

    expect(result.projects.map((project) => project.slug)).toEqual([
      'cards',
      'z-last',
    ])
    expect(result.projects[0].chapters.map((chapter) => chapter.slug)).toEqual([
      'second',
      'first',
    ])
  })
})
