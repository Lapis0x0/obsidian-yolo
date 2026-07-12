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
})
