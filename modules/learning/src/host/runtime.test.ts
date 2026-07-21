import { createHostLearningTranslation } from './runtime'

describe('Learning host runtime i18n', () => {
  it('reads the latest Host locale for every reminder translation', () => {
    let locale = 'en'
    const translate = createHostLearningTranslation({
      i18n: {
        getSnapshot: () => ({ locale }),
        subscribe: () => () => undefined,
      },
    })

    expect(
      translate(
        'learning.background.reviewLabel',
        'YOLO Learning: {count} cards due today',
      ),
    ).toBe('YOLO Learning: {count} cards due today')
    locale = 'zh-CN'
    expect(
      translate(
        'learning.background.reviewLabel',
        'YOLO Learning: {count} cards due today',
      ),
    ).toBe('YOLO Learning：今日有 {count} 张待复习卡片')
  })
})
