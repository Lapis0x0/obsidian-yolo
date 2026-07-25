jest.mock('obsidian', () => ({
  MarkdownView: class MarkdownView {},
}))

import { MarkdownView } from 'obsidian'
import type { TFile, Workspace } from 'obsidian'

import { getMarkdownInsertionTarget } from './markdownInsertionTarget'

type InsertionWorkspace = Pick<
  Workspace,
  'getActiveViewOfType' | 'getLeavesOfType'
> & { lastActiveFile?: TFile | null }

function createMarkdownView({
  path,
  ownerDocument,
  visible = true,
}: {
  path: string
  ownerDocument: Document
  visible?: boolean
}): MarkdownView {
  return Object.assign(Object.create(MarkdownView.prototype), {
    file: { path },
    containerEl: {
      ownerDocument,
      isShown: () => visible,
    },
  }) as MarkdownView
}

function createWorkspace({
  lastActivePath,
  views,
  activeView = null,
}: {
  lastActivePath: string | null
  views: MarkdownView[]
  activeView?: MarkdownView | null
}): InsertionWorkspace {
  return {
    lastActiveFile: lastActivePath ? { path: lastActivePath } : null,
    getLeavesOfType: () => views.map((view) => ({ view })),
    getActiveViewOfType: () => activeView,
  } as unknown as InsertionWorkspace
}

describe('getMarkdownInsertionTarget', () => {
  it('uses the visible view for the last active file instead of the first markdown leaf', () => {
    const mainWindow = {} as Document
    const popoutWindow = {} as Document
    const firstMainView = createMarkdownView({
      path: 'main.md',
      ownerDocument: mainWindow,
    })
    const lastActivePopoutView = createMarkdownView({
      path: 'popout.md',
      ownerDocument: popoutWindow,
    })

    const target = getMarkdownInsertionTarget(
      createWorkspace({
        lastActivePath: 'popout.md',
        views: [firstMainView, lastActivePopoutView],
      }),
      popoutWindow,
    )

    expect(target).toBe(lastActivePopoutView)
  })

  it('prefers the last active file view in the chat window when it is open in multiple windows', () => {
    const mainWindow = {} as Document
    const popoutWindow = {} as Document
    const mainView = createMarkdownView({
      path: 'shared.md',
      ownerDocument: mainWindow,
    })
    const popoutView = createMarkdownView({
      path: 'shared.md',
      ownerDocument: popoutWindow,
    })

    const target = getMarkdownInsertionTarget(
      createWorkspace({
        lastActivePath: 'shared.md',
        views: [mainView, popoutView],
      }),
      popoutWindow,
    )

    expect(target).toBe(popoutView)
  })

  it('does not insert into an unrelated visible note when the last active view is hidden', () => {
    const mainWindow = {} as Document
    const hiddenLastActiveView = createMarkdownView({
      path: 'last-active.md',
      ownerDocument: mainWindow,
      visible: false,
    })
    const unrelatedVisibleView = createMarkdownView({
      path: 'unrelated.md',
      ownerDocument: mainWindow,
    })

    const target = getMarkdownInsertionTarget(
      createWorkspace({
        lastActivePath: 'last-active.md',
        views: [unrelatedVisibleView, hiddenLastActiveView],
      }),
      mainWindow,
    )

    expect(target).toBeNull()
  })
})
