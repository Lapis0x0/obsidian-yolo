import { App, TFile, TFolder } from 'obsidian'

import { scanProject } from './projectScanner'

describe('scanProject', () => {
  it('scans a newly written project before the metadata cache is ready', async () => {
    const projectFolder = new TFolder()
    const indexFile = new TFile()
    const chapterFolder = new TFolder()
    const knowledgeFile = new TFile()

    Object.assign(indexFile, {
      name: 'index.md',
      path: 'YOLO/learning/test/index.md',
    })
    Object.assign(knowledgeFile, {
      name: 'knowledge.md',
      path: 'YOLO/learning/test/01-basics/knowledge.md',
      stat: { mtime: 1 },
    })
    Object.assign(chapterFolder, {
      name: '01-basics',
      path: 'YOLO/learning/test/01-basics',
      children: [knowledgeFile],
    })
    Object.assign(projectFolder, {
      name: 'test',
      path: 'YOLO/learning/test',
      children: [indexFile, chapterFolder],
    })

    const contents = new Map([
      [
        indexFile.path,
        '---\ntopic: 测试项目\ngoal: 验证即时扫描\nstatus: building\nchapters:\n  - 01-basics\n---\n',
      ],
      [
        knowledgeFile.path,
        '---\ntitle: 基础知识\n---\n\n## 第一个知识点 <!--kp:abc12345-->\n',
      ],
    ])
    const getFileCache = jest.fn(() => null)
    const app = {
      vault: {
        cachedRead: jest.fn((file: TFile) =>
          Promise.resolve(contents.get(file.path) ?? ''),
        ),
      },
      metadataCache: {
        getFileCache,
      },
    } as unknown as App

    const project = await scanProject(app, projectFolder)

    expect(project).toMatchObject({
      kind: 'outline',
      id: 'YOLO/learning/test',
      topic: '测试项目',
      status: 'building',
      chapters: [
        {
          id: 'YOLO/learning/test/01-basics',
          title: '基础知识',
        },
      ],
      knowledgePoints: [
        {
          id: 'YOLO/learning/test/01-basics/abc12345',
          title: '第一个知识点',
        },
      ],
    })
    expect(getFileCache).not.toHaveBeenCalled()
  })

  it('scans a cards project in declared order and excludes assets/ref', async () => {
    const file = (name: string, path: string) =>
      Object.assign(new TFile(), { name, path, stat: { mtime: 1 } })
    const folder = (
      name: string,
      path: string,
      children: Array<TFile | TFolder>,
    ) => Object.assign(new TFolder(), { name, path, children })
    const projectIndex = file('index.md', 'learning/cards/index.md')
    const secondIndex = file('index.md', 'learning/cards/second/index.md')
    const secondCards = file('cards.md', 'learning/cards/second/cards.md')
    const firstIndex = file('index.md', 'learning/cards/first/index.md')
    const firstCards = file('cards.md', 'learning/cards/first/cards.md')
    const projectFolder = folder('cards', 'learning/cards', [
      projectIndex,
      folder('first', 'learning/cards/first', [firstIndex, firstCards]),
      folder('assets', 'learning/cards/assets', [
        file('index.md', 'learning/cards/assets/index.md'),
        file('cards.md', 'learning/cards/assets/cards.md'),
      ]),
      folder('second', 'learning/cards/second', [secondIndex, secondCards]),
      folder('ref', 'learning/cards/ref', [
        file('index.md', 'learning/cards/ref/index.md'),
        file('cards.md', 'learning/cards/ref/cards.md'),
      ]),
    ])
    const contents = new Map([
      [
        projectIndex.path,
        '---\nkind: cards\ntopic: 卡片项目\ngoal: 直接学习\nchapters:\n  - second\n  - assets\n  - first\n  - ref\n---\n',
      ],
      [secondIndex.path, '---\ntitle: 第二章\n---\n'],
      [secondCards.path, '---\ntitle: 第二章卡片\n---\n'],
      [firstIndex.path, '---\ntitle: 第一章\n---\n'],
      [firstCards.path, '---\ntitle: 第一章卡片\n---\n'],
    ])
    const app = {
      vault: {
        cachedRead: jest.fn((entry: TFile) =>
          Promise.resolve(contents.get(entry.path) ?? ''),
        ),
      },
    } as unknown as App

    const project = await scanProject(app, projectFolder)

    expect(project).toMatchObject({
      kind: 'cards',
      knowledgePoints: [],
      chapters: [
        {
          slug: 'second',
          title: '第二章',
          cardsFilePath: 'learning/cards/second/cards.md',
        },
        {
          slug: 'first',
          title: '第一章',
          cardsFilePath: 'learning/cards/first/cards.md',
        },
      ],
    })
  })
})
