import { mountCardMarkdown } from './cardMarkdownLifecycle'

describe('mountCardMarkdown', () => {
  it('uses the card source path for links and unloads the renderer', () => {
    const container = { replaceChildren: jest.fn() } as unknown as HTMLElement
    const render = jest.fn().mockResolvedValue(undefined)
    const unload = jest.fn()
    const service = {
      createRenderer: () => ({ render, unload }),
    }

    const cleanup = mountCardMarkdown(
      service,
      container,
      '[[linked note]]\n\n![[image.png]]',
      'learning/project/chapter/cards.md',
    )

    expect(render).toHaveBeenCalledWith(
      '[[linked note]]\n\n![[image.png]]',
      container,
      'learning/project/chapter/cards.md',
    )
    cleanup()
    expect(unload).toHaveBeenCalledTimes(1)
    expect((container.replaceChildren as jest.Mock).mock.calls).toHaveLength(2)
  })
})
