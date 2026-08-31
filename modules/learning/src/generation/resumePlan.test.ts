import type {
  LearningVaultEntry,
  LearningVaultReadApi,
} from '../domain/learningVaultReadApi'
import type {
  LearningVaultFileSnapshot,
  LearningVaultWriteApi,
} from '../domain/learningVaultWriteApi'

import { buildCardsContent } from './cardGenerator'
import { buildChapterKnowledgeBaseline } from './projectWriter'
import {
  LearningProjectResumeUnavailableError,
  buildProjectResumePlan,
  isProjectResumePlanFullyGenerated,
} from './resumePlan'

const PROJECT_PATH = 'Learning/rust-basics'

function indexMarkdown(overrides: Record<string, unknown> = {}): string {
  const frontmatter: Record<string, unknown> = {
    topic: 'Rust basics',
    goal: 'Learn ownership',
    status: 'studying',
    chapters: ['01-ownership', '02-borrowing'],
    level: 'beginner',
    outputLanguage: 'English',
    ...overrides,
  }
  const yaml = Object.entries(frontmatter)
    .map(([key, value]) =>
      Array.isArray(value)
        ? `${key}:\n${value.map((item) => `  - ${item}`).join('\n')}`
        : `${key}: ${String(value)}`,
    )
    .join('\n')
  return `---\n${yaml}\n---\n\n1. [[01-ownership/knowledge|Ownership]]\n`
}

function completeKnowledgeMarkdown(title: string, contract: string): string {
  const baseline = buildChapterKnowledgeBaseline({ title, contract })
  const withContent = `${baseline.trimEnd()}\n\n## What is ownership <!--kp:aaaaaaaa-->\n\nBody text.\n`
  return withContent.replace('complete: false', 'complete: true')
}

function createVault(files: Record<string, string>): {
  vault: LearningVaultReadApi
  vaultWriter: LearningVaultWriteApi
} {
  const backing = new Map<string, string>(Object.entries(files))
  const folders = new Set<string>()
  for (const path of backing.keys()) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      folders.add(parts.slice(0, i).join('/'))
    }
  }
  const getEntry = (path: string): LearningVaultEntry | null => {
    if (backing.has(path)) {
      return {
        kind: 'file',
        path,
        name: path.split('/').at(-1) ?? path,
        ctime: 0,
        mtime: 0,
      }
    }
    if (folders.has(path)) {
      return { kind: 'folder', path, name: path.split('/').at(-1) ?? path }
    }
    return null
  }
  const vault = {
    getEntry,
    listChildren: () => [],
    listMarkdownFiles: () => [],
    exists: async (path: string) => backing.has(path),
    readText: async (path: string) => {
      const content = backing.get(path)
      if (content === undefined) throw new Error(`Not found: ${path}`)
      return content
    },
    readBinary: async () => new ArrayBuffer(0),
    onCreate: () => () => undefined,
    onModify: () => () => undefined,
    onDelete: () => () => undefined,
    onRename: () => () => undefined,
  } as unknown as LearningVaultReadApi
  const vaultWriter = {
    readTextSnapshot: async (
      path: string,
    ): Promise<LearningVaultFileSnapshot | null> => {
      const content = backing.get(path)
      if (content === undefined) return null
      return { path, content }
    },
  } as unknown as LearningVaultWriteApi
  return { vault, vaultWriter }
}

describe('buildProjectResumePlan', () => {
  it('rejects a path with no project index', async () => {
    const { vault, vaultWriter } = createVault({})
    await expect(
      buildProjectResumePlan({
        vault,
        vaultWriter,
        projectPath: PROJECT_PATH,
        generateCards: true,
      }),
    ).rejects.toBeInstanceOf(LearningProjectResumeUnavailableError)
  })

  it('rejects a project created before resume support (missing level/outputLanguage)', async () => {
    const legacyIndex = `---\ntopic: Rust basics\ngoal: Learn ownership\nstatus: studying\nchapters:\n  - 01-ownership\n---\n\n1. [[01-ownership/knowledge|Ownership]]\n`
    const { vault, vaultWriter } = createVault({
      [`${PROJECT_PATH}/index.md`]: legacyIndex,
    })
    await expect(
      buildProjectResumePlan({
        vault,
        vaultWriter,
        projectPath: PROJECT_PATH,
        generateCards: true,
      }),
    ).rejects.toBeInstanceOf(LearningProjectResumeUnavailableError)
  })

  it('rejects a chapter missing its persisted contract', async () => {
    const { vault, vaultWriter } = createVault({
      [`${PROJECT_PATH}/index.md`]: indexMarkdown({
        chapters: ['01-ownership'],
      }),
      [`${PROJECT_PATH}/01-ownership/knowledge.md`]:
        '---\ntitle: Ownership\n---\n\n',
    })
    await expect(
      buildProjectResumePlan({
        vault,
        vaultWriter,
        projectPath: PROJECT_PATH,
        generateCards: true,
      }),
    ).rejects.toBeInstanceOf(LearningProjectResumeUnavailableError)
  })

  it('derives all three chapter states and reference-dir presence', async () => {
    const { vault, vaultWriter } = createVault({
      [`${PROJECT_PATH}/index.md`]: indexMarkdown({
        chapters: ['01-complete', '02-cards-missing', '03-needs-generation'],
      }),
      // Chapter 1: knowledge complete, cards already generated -> 'complete'.
      [`${PROJECT_PATH}/01-complete/knowledge.md`]: completeKnowledgeMarkdown(
        'Complete chapter',
        'Contract one',
      ),
      [`${PROJECT_PATH}/01-complete/cards.md`]: buildCardsContent(
        'Complete chapter',
        ['## A\n\nfront\n---\nback'],
      ),
      // Chapter 2: knowledge complete, cards missing -> 'cards-missing'.
      [`${PROJECT_PATH}/02-cards-missing/knowledge.md`]:
        completeKnowledgeMarkdown('Cards missing chapter', 'Contract two'),
      // Chapter 3: knowledge left incomplete (interrupted mid-run) -> 'needs-generation'.
      [`${PROJECT_PATH}/03-needs-generation/knowledge.md`]: `${buildChapterKnowledgeBaseline(
        { title: 'Needs generation chapter', contract: 'Contract three' },
      ).trimEnd()}\n\n## Partial point <!--kp:bbbbbbbb-->\n\nUnfinished.\n`,
      // Reference materials directory from an earlier staged upload.
      [`${PROJECT_PATH}/ref/notes.md`]: 'reference content',
    })

    const plan = await buildProjectResumePlan({
      vault,
      vaultWriter,
      projectPath: PROJECT_PATH,
      generateCards: true,
    })

    expect(plan.level).toBe('beginner')
    expect(plan.outputLanguage).toBe('English')
    expect(plan.referenceDir).toBe(`${PROJECT_PATH}/ref`)
    expect(plan.chapters).toHaveLength(3)

    const [complete, cardsMissing, needsGeneration] = plan.chapters
    expect(complete.state).toBe('complete')
    expect(complete.existingKnowledgePoints).toEqual([
      { uuid: 'aaaaaaaa', title: 'What is ownership' },
    ])

    expect(cardsMissing.state).toBe('cards-missing')
    expect(cardsMissing.existingKnowledgePoints).toEqual([
      { uuid: 'aaaaaaaa', title: 'What is ownership' },
    ])

    // A chapter interrupted mid-run must not surface its partial knowledge
    // points — resume resets and reruns it from scratch instead of building
    // on an unknown-complete partial set.
    expect(needsGeneration.state).toBe('needs-generation')
    expect(needsGeneration.existingKnowledgePoints).toEqual([])
    expect(needsGeneration.chapterContract).toBe('Contract three')

    expect(isProjectResumePlanFullyGenerated(plan)).toBe(false)
  })

  it('treats knowledge-complete chapters as complete when cards are disabled', async () => {
    const { vault, vaultWriter } = createVault({
      [`${PROJECT_PATH}/index.md`]: indexMarkdown({
        chapters: ['01-ownership'],
      }),
      [`${PROJECT_PATH}/01-ownership/knowledge.md`]: completeKnowledgeMarkdown(
        'Ownership',
        'Contract one',
      ),
    })

    const plan = await buildProjectResumePlan({
      vault,
      vaultWriter,
      projectPath: PROJECT_PATH,
      generateCards: false,
    })

    expect(plan.chapters[0].state).toBe('complete')
    expect(isProjectResumePlanFullyGenerated(plan)).toBe(true)
  })

  it('treats a cards.md that is still the empty shell as missing', async () => {
    const { vault, vaultWriter } = createVault({
      [`${PROJECT_PATH}/index.md`]: indexMarkdown({
        chapters: ['01-ownership'],
      }),
      [`${PROJECT_PATH}/01-ownership/knowledge.md`]: completeKnowledgeMarkdown(
        'Ownership',
        'Contract one',
      ),
      [`${PROJECT_PATH}/01-ownership/cards.md`]: buildCardsContent(
        'Ownership',
        [],
      ),
    })

    const plan = await buildProjectResumePlan({
      vault,
      vaultWriter,
      projectPath: PROJECT_PATH,
      generateCards: true,
    })

    expect(plan.chapters[0].state).toBe('cards-missing')
  })
})

describe('isProjectResumePlanFullyGenerated', () => {
  it('is true only when every chapter is complete', () => {
    const base = {
      projectPath: PROJECT_PATH,
      topic: 'T',
      goal: 'G',
      level: 'beginner',
      outputLanguage: 'English',
    }
    expect(
      isProjectResumePlanFullyGenerated({
        ...base,
        chapters: [
          {
            chapterIndex: 0,
            chapterTitle: 'A',
            chapterContract: 'C',
            target: {
              chapterIndex: 0,
              chapterTitle: 'A',
              chapterSlug: 'a',
              chapterPath: `${PROJECT_PATH}/a`,
              knowledgePath: `${PROJECT_PATH}/a/knowledge.md`,
              cardsPath: `${PROJECT_PATH}/a/cards.md`,
            },
            state: 'complete',
            existingKnowledgePoints: [],
          },
        ],
      }),
    ).toBe(true)
  })
})
