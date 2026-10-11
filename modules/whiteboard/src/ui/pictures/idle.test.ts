import { IdleSlices } from './idle'

/** A window whose idle periods the test hands out by hand. */
function fakeWindow() {
  const idle: ((deadline: IdleDeadline) => void)[] = []
  const win = {
    requestIdleCallback: (callback: (deadline: IdleDeadline) => void) =>
      idle.push(callback),
    cancelIdleCallback: () => undefined,
    setTimeout,
    clearTimeout,
  } as unknown as Window
  /** Runs the idle callbacks waiting now, each given `ms` to spare. */
  const period = (ms: number): void => {
    for (const callback of idle.splice(0)) {
      callback({ timeRemaining: () => ms, didTimeout: false })
    }
  }
  return { win, period, waiting: () => idle.length }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('IdleSlices', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('hands out a slice in an idle period with time to spare', async () => {
    const { win, period } = fakeWindow()
    const slices = new IdleSlices(win, () => true, 8)
    let got: boolean | null = null
    void slices.next().then((ok) => {
      got = ok
    })

    period(3)
    await settle()
    expect(got).toBeNull()

    period(12)
    await settle()
    expect(got).toBe(true)
  })

  it('waits while the board is not ready, and asks again later', async () => {
    const { win, period, waiting } = fakeWindow()
    let ready = false
    const slices = new IdleSlices(win, () => ready, 8)
    let got: boolean | null = null
    void slices.next().then((ok) => {
      got = ok
    })

    period(40)
    await settle()
    expect(got).toBeNull()
    // Not asked again until a while has passed.
    expect(waiting()).toBe(0)

    ready = true
    jest.advanceTimersByTime(200)
    period(40)
    await settle()
    expect(got).toBe(true)
  })

  it('answers no to every wait once destroyed', async () => {
    const { win } = fakeWindow()
    const slices = new IdleSlices(win, () => true, 8)
    const pending = slices.next()
    slices.destroy()
    await expect(pending).resolves.toBe(false)
    await expect(slices.next()).resolves.toBe(false)
  })
})
