export const learningTabs = ['大纲', '知识地图', '卡片', '习题'] as const

export type LearningTabKey = (typeof learningTabs)[number]

export const defaultLearningTab: LearningTabKey = '大纲'

export function isLearningTabKey(value: unknown): value is LearningTabKey {
  return learningTabs.includes(value as LearningTabKey)
}
