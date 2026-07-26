import { BackgroundExecutionController } from './backgroundExecutionController'

const createTarget = (initialAllowed = true) => {
  let allowed = initialAllowed
  return {
    getBackgroundThrottling: jest.fn(() => allowed),
    setBackgroundThrottling: jest.fn((nextAllowed: boolean) => {
      allowed = nextAllowed
    }),
  }
}

describe('BackgroundExecutionController', () => {
  it('disables throttling for the first lease and restores it after the last', async () => {
    const target = createTarget()
    const controller = new BackgroundExecutionController(async () => target)

    const releaseFirst = await controller.acquire()
    const releaseSecond = await controller.acquire()

    expect(target.setBackgroundThrottling).toHaveBeenCalledTimes(1)
    expect(target.setBackgroundThrottling).toHaveBeenLastCalledWith(false)

    releaseFirst()
    expect(target.setBackgroundThrottling).toHaveBeenCalledTimes(1)

    releaseSecond()
    expect(target.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
    expect(target.setBackgroundThrottling).toHaveBeenCalledTimes(2)
  })

  it('preserves a host that already disabled throttling', async () => {
    const target = createTarget(false)
    const controller = new BackgroundExecutionController(async () => target)

    const release = await controller.acquire()
    release()

    expect(target.setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('makes release idempotent and restores during disposal', async () => {
    const target = createTarget()
    const controller = new BackgroundExecutionController(async () => target)
    const release = await controller.acquire()

    release()
    release()
    expect(target.setBackgroundThrottling).toHaveBeenCalledTimes(2)

    const secondController = new BackgroundExecutionController(
      async () => target,
    )
    await secondController.acquire()
    secondController.dispose()
    expect(target.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
  })

  it('does not activate after disposal races an asynchronous load', async () => {
    const target = createTarget()
    let resolveTarget!: (target: ReturnType<typeof createTarget>) => void
    const targetPromise = new Promise<ReturnType<typeof createTarget>>(
      (resolve) => {
        resolveTarget = resolve
      },
    )
    const controller = new BackgroundExecutionController(() => targetPromise)

    const acquirePromise = controller.acquire()
    controller.dispose()
    resolveTarget(target)
    const release = await acquirePromise
    release()

    expect(target.setBackgroundThrottling).not.toHaveBeenCalled()
  })

  it('restores throttling when protected work throws', async () => {
    const target = createTarget()
    const controller = new BackgroundExecutionController(async () => target)

    await expect(
      controller.run(async () => {
        expect(target.setBackgroundThrottling).toHaveBeenLastCalledWith(false)
        throw new Error('task failed')
      }),
    ).rejects.toThrow('task failed')

    expect(target.setBackgroundThrottling).toHaveBeenLastCalledWith(true)
  })
})
