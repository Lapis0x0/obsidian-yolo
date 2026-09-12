jest.mock('./StreamingMarkdown', () => ({
  __esModule: true,
  default: ({
    content,
    contentSource,
  }: {
    content: string
    contentSource?: { getContent: () => string } | null
  }) => (
    // 播放器真正显示的是源的当前值，落到 `content` 只是源缺席时的回退。
    <span data-renderer="streaming">
      {contentSource?.getContent() ?? content}
    </span>
  ),
}))

jest.mock('./ObsidianMarkdown', () => ({
  __esModule: true,
  ObsidianMarkdown: ({ content }: { content: string }) => (
    <span data-renderer="full">{content}</span>
  ),
}))

import { renderToStaticMarkup } from 'react-dom/server'

import TransitioningMarkdown from './TransitioningMarkdown'

const liveSource = (value: string) => ({
  getContent: () => value,
  subscribe: () => () => {},
})

describe('TransitioningMarkdown', () => {
  /*
   * 思考块的 `generationState` 是它自己的展示态：正文一出字就翻成非 streaming，
   * 好让折叠态的预览轨道停止脉动。但这时整条消息还在生成，思考流仍挂着命令式
   * 源、文本仍可能继续来。只看展示态选渲染器，展开的思考正文就会停在落后的快
   * 照值上，直到终态快照才一次跳到最终内容。
   */
  it('stays on the player while a live source is attached, even after the display state settles', () => {
    const html = renderToStaticMarkup(
      <TransitioningMarkdown
        content="快照里落后的思考文本"
        contentSource={liveSource('实时源里最新的思考文本')}
        generationState="completed"
      />,
    )

    expect(html).toContain('data-renderer="streaming"')
    expect(html).toContain('实时源里最新的思考文本')
    expect(html).not.toContain('快照里落后的思考文本')
  })

  it('stays on the player while the display state is streaming without a source', () => {
    const html = renderToStaticMarkup(
      <TransitioningMarkdown
        content="逐次更新进来的正文"
        generationState="streaming"
      />,
    )

    expect(html).toContain('data-renderer="streaming"')
    expect(html).toContain('逐次更新进来的正文')
  })

  // 源被置空且展示态已收尾，`content` 就是终态文本，交给全量渲染器。
  it('hands a settled message to the full renderer', () => {
    const html = renderToStaticMarkup(
      <TransitioningMarkdown content="终态文本" generationState="completed" />,
    )

    expect(html).toContain('data-renderer="full"')
    expect(html).toContain('终态文本')
  })
})
