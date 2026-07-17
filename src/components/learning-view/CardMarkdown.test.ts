import { mountCardMarkdown } from './cardMarkdownLifecycle'
import type { LearningUiBridge } from './LearningUiHost'

describe('mountCardMarkdown', () => {
  it('renders with the card source path and cleans up the container', () => {
    const container = { replaceChildren: jest.fn() } as unknown as HTMLElement
    const render = jest.fn().mockResolvedValue(undefined)
    const unload = jest.fn()
    const bridge = {
      createMarkdownRenderer: () => ({ render, unload }),
    } as unknown as LearningUiBridge

    const cleanup = mountCardMarkdown(
      bridge,
      container,
      '![[image.png]]\n\n![[audio.mp3]]',
      'learning/cards/chapter/cards.md',
    )

    expect(render).toHaveBeenCalledWith(
      '![[image.png]]\n\n![[audio.mp3]]',
      container,
      'learning/cards/chapter/cards.md',
    )
    cleanup()
    expect(unload).toHaveBeenCalledTimes(1)
    expect((container.replaceChildren as jest.Mock).mock.calls).toHaveLength(2)
  })
})
