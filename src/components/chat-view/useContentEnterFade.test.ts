import { isVisibleContentChanged } from './useContentEnterFade'

const home = (projectId: string | null, conversationId: string) => ({
  empty: true,
  projectId,
  conversationId,
})
const conversation = (conversationId: string) => ({
  empty: false,
  projectId: null,
  conversationId,
})

describe('isVisibleContentChanged', () => {
  it('在同一个主页上换 Agent 或开新对话不算换', () => {
    expect(isVisibleContentChanged(home('p1', 'a'), home('p1', 'b'))).toBe(
      false,
    )
    expect(isVisibleContentChanged(home(null, 'a'), home(null, 'b'))).toBe(
      false,
    )
  })

  it('换到另一个主页算换', () => {
    expect(isVisibleContentChanged(home('p1', 'a'), home(null, 'b'))).toBe(true)
    expect(isVisibleContentChanged(home('p1', 'a'), home('p2', 'b'))).toBe(true)
  })

  it('发出第一条消息时对话不变，不算换', () => {
    expect(isVisibleContentChanged(home('p1', 'a'), conversation('a'))).toBe(
      false,
    )
  })

  it('对话与主页、对话与对话之间切换算换', () => {
    expect(isVisibleContentChanged(conversation('a'), home('p1', 'b'))).toBe(
      true,
    )
    expect(isVisibleContentChanged(home(null, 'a'), conversation('b'))).toBe(
      true,
    )
    expect(isVisibleContentChanged(conversation('a'), conversation('b'))).toBe(
      true,
    )
  })
})
