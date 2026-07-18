export const LEARNING_MODULE_ID = 'learning'

type ActiveModuleRuntime = Readonly<{
  isActive(moduleId: string, version?: string): boolean
}>

type LearningWorkspaceLeaf = Readonly<{
  setViewState(state: {
    type: string
    active: true
    state?: Readonly<Record<string, unknown>>
  }): Promise<void>
}>

type LearningWorkspace = Readonly<{
  getLeavesOfType(type: string): readonly LearningWorkspaceLeaf[]
  getLeaf(kind: 'tab'): LearningWorkspaceLeaf
  revealLeaf(leaf: LearningWorkspaceLeaf): void
}>

export function isLearningModuleOwner(
  runtime: ActiveModuleRuntime | null,
): boolean {
  return runtime?.isActive(LEARNING_MODULE_ID) === true
}

export async function openLearningModuleView(
  workspace: LearningWorkspace,
  viewType: string,
  navigationTarget?: unknown,
): Promise<void> {
  const leaf =
    workspace.getLeavesOfType(viewType)[0] ?? workspace.getLeaf('tab')
  await leaf.setViewState({
    type: viewType,
    active: true,
    ...(navigationTarget === undefined ? {} : { state: { navigationTarget } }),
  })
  workspace.revealLeaf(leaf)
}
