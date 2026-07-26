jest.mock('obsidian', () => ({
  MarkdownView: class MarkdownView {},
}))

import { MarkdownView } from 'obsidian'
import type { Workspace, WorkspaceLeaf } from 'obsidian'

import { MarkdownInsertionTargetTracker } from './markdownInsertionTarget'

type InsertionWorkspace = Pick<
  Workspace,
  'getActiveViewOfType' | 'getLeavesOfType'
>

function createMarkdownView({
  path,
  visible = true,
}: {
  path: string
  visible?: boolean
}): MarkdownView {
  return Object.assign(Object.create(MarkdownView.prototype), {
    file: { path },
    containerEl: {
      isShown: () => visible,
    },
  }) as MarkdownView
}

function createLeaf(view: unknown): WorkspaceLeaf {
  return { view } as WorkspaceLeaf
}

function createWorkspace({
  leaves,
  activeView = null,
}: {
  leaves: WorkspaceLeaf[]
  activeView?: MarkdownView | null
}): InsertionWorkspace {
  return {
    getLeavesOfType: () => leaves,
    getActiveViewOfType: () => activeView,
  } as unknown as InsertionWorkspace
}

describe('MarkdownInsertionTargetTracker', () => {
  it('captures the exact active markdown leaf', () => {
    const firstView = createMarkdownView({ path: 'shared.md' })
    const activeView = createMarkdownView({ path: 'shared.md' })
    const workspace = createWorkspace({
      leaves: [createLeaf(firstView), createLeaf(activeView)],
      activeView,
    })
    const tracker = new MarkdownInsertionTargetTracker(workspace)

    tracker.captureCurrentLeaf()

    expect(tracker.getTarget()).toBe(activeView)
  })

  it('keeps the last markdown leaf when the chat leaf becomes active', () => {
    const markdownView = createMarkdownView({ path: 'popout.md' })
    const markdownLeaf = createLeaf(markdownView)
    const tracker = new MarkdownInsertionTargetTracker(
      createWorkspace({ leaves: [markdownLeaf] }),
    )

    tracker.trackActiveLeaf(markdownLeaf)
    tracker.trackActiveLeaf(createLeaf({ type: 'chat' }))

    expect(tracker.getTarget()).toBe(markdownView)
  })

  it('does not use another leaf for the same file after the target closes', () => {
    const closedView = createMarkdownView({ path: 'shared.md' })
    const closedLeaf = createLeaf(closedView)
    const remainingView = createMarkdownView({ path: 'shared.md' })
    const remainingLeaf = createLeaf(remainingView)
    const leaves = [closedLeaf, remainingLeaf]
    const tracker = new MarkdownInsertionTargetTracker(
      createWorkspace({ leaves }),
    )

    tracker.trackActiveLeaf(closedLeaf)
    leaves.splice(leaves.indexOf(closedLeaf), 1)

    expect(tracker.getTarget()).toBeNull()
  })

  it('does not return a hidden markdown view', () => {
    const hiddenView = createMarkdownView({
      path: 'hidden.md',
      visible: false,
    })
    const hiddenLeaf = createLeaf(hiddenView)
    const tracker = new MarkdownInsertionTargetTracker(
      createWorkspace({ leaves: [hiddenLeaf] }),
    )

    tracker.trackActiveLeaf(hiddenLeaf)

    expect(tracker.getTarget()).toBeNull()
  })
})
