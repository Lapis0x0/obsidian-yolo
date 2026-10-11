import { PictureActivity } from './activity'

function setup() {
  const lines = new Map<string, unknown>()
  const background = {
    upsert: jest.fn((activity: { id: string }) =>
      lines.set(activity.id, activity),
    ),
    remove: jest.fn((id: string) => lines.delete(id)),
  } as unknown as YoloModuleHostApiV1['background']
  const activity = new PictureActivity({
    win: window(),
    background,
    board: () => ({ path: 'Boards/Plan.yoloboard', name: 'Plan' }),
    title: () => '正在处理白板缓存',
    reportError: () => undefined,
  })
  return { activity, lines }
}

function window(): Window {
  return { setTimeout, clearTimeout } as unknown as Window
}

describe('PictureActivity', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('shows a line once the board has been busy for a while', () => {
    const { activity, lines } = setup()
    activity.setBusy(true)
    jest.advanceTimersByTime(900)
    expect(lines.size).toBe(0)

    jest.advanceTimersByTime(200)
    expect([...lines.values()]).toEqual([
      {
        id: 'picture-cache:Boards/Plan.yoloboard',
        title: '正在处理白板缓存',
        detail: 'Plan',
        status: 'running',
      },
    ])
  })

  it('shows nothing for a moment of work', () => {
    const { activity, lines } = setup()
    activity.setBusy(true)
    jest.advanceTimersByTime(500)
    activity.setBusy(false)
    jest.advanceTimersByTime(2000)
    expect(lines.size).toBe(0)
  })

  it('keeps the line while busy, and takes it down the moment it is not', () => {
    const { activity, lines } = setup()
    activity.setBusy(true)
    jest.advanceTimersByTime(1500)
    // Told again — a board being moved is still busy — it stays one line.
    activity.setBusy(true)
    jest.advanceTimersByTime(1500)
    expect(lines.size).toBe(1)

    activity.setBusy(false)
    expect(lines.size).toBe(0)
  })

  it('takes the line down when the board closes', () => {
    const { activity, lines } = setup()
    activity.setBusy(true)
    jest.advanceTimersByTime(1500)
    activity.destroy()
    expect(lines.size).toBe(0)
    jest.advanceTimersByTime(5000)
    expect(lines.size).toBe(0)
  })
})
