export type LearningNavigationTarget =
  | { type: 'home' }
  | {
      type: 'project'
      projectId: string
      tab: '卡片'
      cardMode: '学习' | '浏览'
    }

export type LearningNavigationHandler = (
  target: LearningNavigationTarget,
) => void
