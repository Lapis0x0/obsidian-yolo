import { MarkdownRenderer } from 'obsidian'
import type { App } from 'obsidian'

import { mountCardMarkdown } from './cardMarkdownLifecycle'

jest.mock('obsidian', () => ({
  Component: class {
    load = jest.fn()
    unload = jest.fn()
  },
  MarkdownRenderer: { render: jest.fn().mockResolvedValue(undefined) },
}))

describe('mountCardMarkdown', () => {
  it('renders with the card source path and cleans up the container', () => {
    const container = { empty: jest.fn() } as unknown as HTMLElement
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Jest inspects the static mock without invoking it.
    const render = MarkdownRenderer.render as jest.MockedFunction<
      typeof MarkdownRenderer.render
    >

    const cleanup = mountCardMarkdown(
      {} as App,
      container,
      '![[image.png]]\n\n![[audio.mp3]]',
      'learning/cards/chapter/cards.md',
    )

    expect(render).toHaveBeenCalledWith(
      expect.anything(),
      '![[image.png]]\n\n![[audio.mp3]]',
      container,
      'learning/cards/chapter/cards.md',
      expect.anything(),
    )
    cleanup()
    expect((container.empty as jest.Mock).mock.calls).toHaveLength(2)
  })
})
