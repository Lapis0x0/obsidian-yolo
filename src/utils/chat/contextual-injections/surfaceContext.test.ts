import { renderSurfaceContextInjection } from './surfaceContext'

describe('renderSurfaceContextInjection', () => {
  it('renders the surface description as a user message', async () => {
    const result = await renderSurfaceContextInjection({
      type: 'surface-context',
      getText: () => Promise.resolve('  Board: 3 cards\nThis card: n2  '),
    })

    expect(result?.role).toBe('user')
    expect(result?.content).toContain('# Surface Context')
    expect(result?.content).toContain('Board: 3 cards\nThis card: n2')
  })

  // Read at request-build time, not at panel-open time: the board keeps
  // changing while the panel is open.
  it('reads the description on each render', async () => {
    const getText = jest
      .fn()
      .mockReturnValueOnce('first')
      .mockReturnValueOnce('second')
    const injection = { type: 'surface-context' as const, getText }

    expect((await renderSurfaceContextInjection(injection))?.content).toContain(
      'first',
    )
    expect((await renderSurfaceContextInjection(injection))?.content).toContain(
      'second',
    )
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
