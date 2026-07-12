export const tabs = ['大纲', '知识地图', '卡片', '习题'] as const
export type TabKey = (typeof tabs)[number]
