import { resolveStatusLabel } from './OutlineBuilder'

const t = (_key: string, fallback = '') => fallback

describe('resolveStatusLabel', () => {
  it('keeps each generation phase distinguishable for assistive status', () => {
    expect(resolveStatusLabel('outline', t)).toBe('正在生成大纲')
    expect(resolveStatusLabel('knowledge', t)).toBe('正在生成知识点')
    expect(resolveStatusLabel('error', t)).toBe('生成失败')
    expect(resolveStatusLabel('ready', t)).toBe('确认后将交由 Sub-Agent 生成')
  })
})
