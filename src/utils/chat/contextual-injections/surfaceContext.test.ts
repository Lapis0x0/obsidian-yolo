import { renderSurfaceContextInjection } from './surfaceContext'

describe('renderSurfaceContextInjection', () => {
  it('renders the surface description as text', async () => {
    const result = await renderSurfaceContextInjection({
      type: 'surface-context',
      getText: () => Promise.resolve('  Board: 3 cards\nThis card: n2  '),
    })

    expect(result).toEqual([
      { type: 'text', text: expect.stringContaining('# Surface Context') },
    ])
    expect(result?.[0]).toMatchObject({
      text: expect.stringContaining('Board: 3 cards\nThis card: n2'),
    })
  })

  it('injects nothing when there is nothing to say', async () => {
    expect(
      await renderSurfaceContextInjection({
        type: 'surface-context',
        getText: () => '   ',
      }),
    ).toBeNull()
  })

  // The description comes from outside the host; a module that fails to
  // describe its surface degrades the answer instead of failing the request.
  it('degrades to no injection when the surface cannot be described', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await renderSurfaceContextInjection({
        type: 'surface-context',
        getText: () => {
          throw new Error('board is gone')
        },
      }),
    ).toBeNull()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
