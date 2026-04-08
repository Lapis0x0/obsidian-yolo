import { shouldRenderAssistantToolPreview } from './assistantToolPreview'

describe('assistantToolPreview helpers', () => {
  it('keeps the assistant tool preview visible until a tool message arrives', () => {
    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'completed',
        toolCallRequestCount: 1,
        hasToolMessages: false,
      }),
    ).toBe(true)
  })

  it('shows the assistant tool preview while the assistant is still streaming', () => {
    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'streaming',
        toolCallRequestCount: 2,
        hasToolMessages: false,
      }),
    ).toBe(true)
  })

  it('hides the preview once the real tool message is rendered', () => {
    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'completed',
        toolCallRequestCount: 1,
        hasToolMessages: true,
      }),
    ).toBe(false)
  })

  it('does not render the preview for aborted or empty tool states', () => {
    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'aborted',
        toolCallRequestCount: 1,
        hasToolMessages: false,
      }),
    ).toBe(false)

    expect(
      shouldRenderAssistantToolPreview({
        generationState: 'completed',
        toolCallRequestCount: 0,
        hasToolMessages: false,
      }),
    ).toBe(false)
  })
})
