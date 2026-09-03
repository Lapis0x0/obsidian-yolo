import {
  classifyDocumentSummaryInputDrift,
  createDocumentSummaryInputProfile,
} from './documentSummaryManager'

const profile = (content: string) => createDocumentSummaryInputProfile(content)
const repeat = (content: string, times: number) =>
  Array.from({ length: times }, () => content).join('\n')

describe('document summary content drift', () => {
  it('keeps identical content fresh', () => {
    const content = repeat('语音输入需要保留上下文摘要和专有名词。', 20)

    expect(
      classifyDocumentSummaryInputDrift(profile(content), profile(content)),
    ).toBe('fresh')
  })

  it('treats moderate append as soft-stale', () => {
    const previous = repeat('语音输入需要保留上下文摘要和专有名词。', 20)
    const current = `${previous}\n${repeat('新增一段验收说明。', 8)}`

    expect(
      classifyDocumentSummaryInputDrift(profile(previous), profile(current)),
    ).toBe('soft-stale')
  })

  it('treats large append as hard-stale', () => {
    const previous = repeat('语音输入需要保留上下文摘要和专有名词。', 20)
    const current = `${previous}\n${repeat('新增一段验收说明和风险清单。', 18)}`

    expect(
      classifyDocumentSummaryInputDrift(profile(previous), profile(current)),
    ).toBe('hard-stale')
  })

  it('treats a rewrite as hard-stale even at similar length', () => {
    const previous = repeat('语音输入需要保留上下文摘要和专有名词。', 24)
    const current = repeat('发布分支计划改为按灰度渠道逐步推进。', 24)

    expect(
      classifyDocumentSummaryInputDrift(profile(previous), profile(current)),
    ).toBe('hard-stale')
  })
})
