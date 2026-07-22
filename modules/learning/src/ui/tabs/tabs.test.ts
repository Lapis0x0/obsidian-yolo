import { defaultLearningTab, isLearningTabKey, learningTabs } from './tabs'

describe('learning tabs', () => {
  it('keeps a stable module-facing tab contract', () => {
    expect(learningTabs).toEqual(['大纲', '知识地图', '卡片', '习题'])
    expect(defaultLearningTab).toBe('大纲')
  })

  it('rejects unknown navigation values', () => {
    expect(isLearningTabKey('知识地图')).toBe(true)
    expect(isLearningTabKey('knowledge-map')).toBe(false)
    expect(isLearningTabKey(null)).toBe(false)
  })
})
