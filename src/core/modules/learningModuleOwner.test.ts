import {
  isLearningModuleOwner,
  openLearningModuleView,
} from './learningModuleOwner'

describe('Learning module product ownership', () => {
  it('cuts over only after the Learning runtime is active', () => {
    expect(isLearningModuleOwner(null)).toBe(false)
    expect(
      isLearningModuleOwner({
        isActive: (moduleId) => moduleId === 'learning',
      }),
    ).toBe(true)
    expect(isLearningModuleOwner({ isActive: () => false })).toBe(false)
  })

  it('routes navigation through the registered module view state', async () => {
    const setViewState = jest.fn(async () => undefined)
    const leaf = { setViewState }
    const legacyOpen = jest.fn()
    const workspace = {
      getLeavesOfType: jest.fn(() => [leaf]),
      getLeaf: jest.fn(() => leaf),
      revealLeaf: jest.fn(),
    }

    await openLearningModuleView(workspace, 'yolo-learning-view', {
      type: 'home',
    })

    expect(setViewState).toHaveBeenCalledWith({
      type: 'yolo-learning-view',
      active: true,
      state: { navigationTarget: { type: 'home' } },
    })
    expect(workspace.getLeaf).not.toHaveBeenCalled()
    expect(legacyOpen).not.toHaveBeenCalled()
  })
})
