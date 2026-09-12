jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) => {
      if (key === 'chat.reasoning') return '思考过程'
      if (key === 'quickAsk.error') return '生成失败'
      if (key === 'quickAsk.statusGenerating') return '生成中...'
      return fallback ?? ''
    },
  }),
}))

jest.mock('./TransitioningMarkdown', () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <>{content}</>,
}))

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import AssistantMessageReasoning, {
  formatReasoningDurationSeconds,
  getReasoningPreviewFrame,
  getReasoningPreviewHoldOffset,
  getReasoningPreviewViewportMetrics,
  getReasoningRollText,
} from './AssistantMessageReasoning'

describe('AssistantMessageReasoning', () => {
  it('rounds a completed reasoning duration to user-facing seconds', () => {
    expect(formatReasoningDurationSeconds(400)).toBe(1)
    expect(formatReasoningDurationSeconds(70_600)).toBe(71)
  })

  it('shows the completed reasoning duration', () => {
    const html = renderToStaticMarkup(
      <AssistantMessageReasoning
        reasoning="已有思考内容"
        hasAnswerContent
        generationState="completed"
        reasoningDurationMs={70_600}
      />,
    )

    // The label renders as separate title/detail spans, so assert the parts.
    expect(html).toContain('Thought')
    expect(html).toContain('for 71s')
  })

  it('keeps reasoning continuous instead of splitting it into sentences', () => {
    expect(
      getReasoningRollText('先分析用户目标。现在检查项目中的现有实现'),
    ).toBe('先分析用户目标。现在检查项目中的现有实现')
  })

  it('flattens short markdown lines so only the viewport determines wrapping', () => {
    expect(
      getReasoningRollText('# 分析\n\n1. 游戏品质\n2. 玩法设计\n- 最新进展'),
    ).toBe('分析 游戏品质 玩法设计 最新进展')
  })

  it('bounds the text used by the rolling preview', () => {
    const preview = getReasoningRollText('a'.repeat(6500))

    expect(preview).toHaveLength(2500)
    expect(preview).toBe('a'.repeat(2500))
  })

  it('holds back the unfinished visual line once wrapping begins', () => {
    expect(getReasoningPreviewHoldOffset(20, 20)).toBe(0)
    expect(getReasoningPreviewHoldOffset(40, 20)).toBe(20)
    expect(getReasoningPreviewHoldOffset(80, 20)).toBe(20)
  })

  it('grows the viewport without moving the track until the preview caps out', () => {
    const metrics = (contentHeight: number) =>
      getReasoningPreviewViewportMetrics({
        contentHeight,
        holdOffset: getReasoningPreviewHoldOffset(contentHeight, 20),
        lineHeight: 20,
        previewLines: 5,
      })

    // 未封顶：视口贴着可见内容生长，轨道位移恒为 0，只有一条动画在跑。
    expect(metrics(20)).toEqual({
      viewportHeight: 20,
      scrollOffset: 0,
      isOverflowing: false,
    })
    expect(metrics(100)).toEqual({
      viewportHeight: 80,
      scrollOffset: 0,
      isOverflowing: false,
    })
    // 恰好封顶：视口停在上限，位移仍未启动，两条动画不重叠。
    expect(metrics(120)).toEqual({
      viewportHeight: 100,
      scrollOffset: 0,
      isOverflowing: false,
    })
    // 封顶后：视口恒定，超出多少就往上滚多少。
    expect(metrics(140)).toEqual({
      viewportHeight: 100,
      scrollOffset: 20,
      isOverflowing: true,
    })
  })

  // ResizeObserver 回调拿到的就是这两个数（轨道盒子的宽高），下面这组用例
  // 描述的是"这一次量测该写什么 CSS 变量、要不要跑位移动画"。
  describe('getReasoningPreviewFrame', () => {
    const frame = ({
      height,
      width = 300,
      previousWidth = 300,
      previousHeight,
      previousScrollOffset = 0,
    }: {
      height: number
      width?: number
      previousWidth?: number
      previousHeight: number
      previousScrollOffset?: number
    }) =>
      getReasoningPreviewFrame({
        width,
        height,
        lineHeight: 20,
        previewLines: 5,
        previousWidth,
        previousHeight,
        previousScrollOffset,
      })

    it('writes the viewport height and never animates the very first measurement', () => {
      expect(frame({ height: 60, previousHeight: 0 })).toEqual({
        viewportHeight: 40,
        scrollOffset: 0,
        isOverflowing: false,
        transition: 'reset',
      })
    })

    it('holds the running animation while new text stays on the same visual line', () => {
      expect(
        frame({ height: 140, previousHeight: 140, previousScrollOffset: 20 }),
      ).toMatchObject({ scrollOffset: 20, transition: 'hold' })
    })

    it('animates the track once the preview is capped and grows further', () => {
      expect(
        frame({ height: 160, previousHeight: 140, previousScrollOffset: 20 }),
      ).toEqual({
        viewportHeight: 100,
        scrollOffset: 40,
        isOverflowing: true,
        transition: 'animate',
      })
    })

    it('drops the animation when rewrapping or shrinking makes the offset meaningless', () => {
      expect(
        frame({
          height: 160,
          width: 240,
          previousHeight: 140,
          previousScrollOffset: 20,
        }),
      ).toMatchObject({ transition: 'reset' })
      expect(
        frame({ height: 120, previousHeight: 160, previousScrollOffset: 40 }),
      ).toMatchObject({ transition: 'reset' })
    })
  })

  // 折叠态由预览轨道呈现"正在想什么"，全文一行都不该挂在 DOM 里——否则那棵
  // 上万字的子树虽然被压成零高，仍然要参与每一次布局。
  it('does not mount the reasoning body while collapsed', () => {
    const html = renderToStaticMarkup(
      <AssistantMessageReasoning
        reasoning="思考正文不该出现在折叠态里"
        hasAnswerContent
        generationState="completed"
        reasoningDurationMs={1_200}
      />,
    )

    expect(html).not.toContain('yolo-assistant-message-metadata-content')
    expect(html).not.toContain('思考正文不该出现在折叠态里')
    expect(html).toContain('yolo-assistant-message-metadata-toggle')
  })

  it('keeps the reasoning title when the response generation fails', () => {
    const html = renderToStaticMarkup(
      <AssistantMessageReasoning
        reasoning="已有思考内容"
        hasAnswerContent
        generationState="error"
      />,
    )

    expect(html).toContain('思考过程')
    expect(html).not.toContain('生成失败')
    expect(html).toContain('data-stage="settled"')
  })

  it('keeps the reasoning title while more answer content is generated', () => {
    const html = renderToStaticMarkup(
      <AssistantMessageReasoning
        reasoning="已有思考内容"
        hasAnswerContent
        generationState="streaming"
      />,
    )

    expect(html).toContain('思考过程')
    expect(html).not.toContain('生成中')
    expect(html).toContain('data-stage="settled"')
  })
})
