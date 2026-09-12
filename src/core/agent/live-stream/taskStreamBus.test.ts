import { LiveTaskStreamBus } from './taskStreamBus'

function pushRun(
  bus: LiveTaskStreamBus,
  toolCallId: string,
  { terminate }: { terminate: boolean },
): void {
  bus.push({ type: 'status', toolCallId, status: 'starting' })
  bus.push({ type: 'stdout', toolCallId, chunk: 'output\n', ts: 0 })
  if (terminate) {
    bus.push({ type: 'status', toolCallId, status: 'done' })
  }
}

describe('LiveTaskStreamBus', () => {
  it('keeps the snapshot of a task that has not reached a terminal status', () => {
    const bus = new LiveTaskStreamBus()

    pushRun(bus, 'call-1', { terminate: false })

    expect(bus.getSnapshot('call-1')).toEqual({
      stdout: 'output\n',
      stderr: '',
      status: 'starting',
    })
  })

  it('recycles a terminal snapshot that nobody is subscribed to', () => {
    const bus = new LiveTaskStreamBus()

    pushRun(bus, 'call-1', { terminate: true })

    expect(bus.getSnapshot('call-1')).toBeNull()
  })

  it('keeps a terminal snapshot readable while a subscriber is still mounted', () => {
    const bus = new LiveTaskStreamBus()
    const seen: (string | null)[] = []
    const unsubscribe = bus.subscribe('call-1', () => {
      seen.push(bus.getSnapshot('call-1')?.status ?? null)
    })

    pushRun(bus, 'call-1', { terminate: true })

    // 终态事件到达时订阅者仍能读到完整快照，卡片据此完成最后一次渲染。
    expect(seen).toEqual(['starting', 'starting', 'done'])
    expect(bus.getSnapshot('call-1')).toEqual({
      stdout: 'output\n',
      stderr: '',
      status: 'done',
    })

    unsubscribe()

    expect(bus.getSnapshot('call-1')).toBeNull()
  })

  it('keeps a still-running snapshot when its last subscriber unmounts', () => {
    const bus = new LiveTaskStreamBus()
    const unsubscribe = bus.subscribe('call-1', () => {})

    pushRun(bus, 'call-1', { terminate: false })
    unsubscribe()

    // 后台命令还在写输出，卡片只是被滚出了视图，快照必须留着。
    expect(bus.getSnapshot('call-1')?.stdout).toBe('output\n')

    bus.push({ type: 'status', toolCallId: 'call-1', status: 'done' })

    expect(bus.getSnapshot('call-1')).toBeNull()
  })

  it('converges instead of growing across many tool calls', () => {
    const bus = new LiveTaskStreamBus()
    const ids = Array.from({ length: 50 }, (_, index) => `call-${index}`)

    for (const toolCallId of ids) {
      const unsubscribe = bus.subscribe(toolCallId, () => {})
      pushRun(bus, toolCallId, { terminate: true })
      unsubscribe()
    }

    expect(ids.filter((id) => bus.getSnapshot(id) !== null)).toEqual([])
  })

  it('starts a fresh snapshot when the same tool call id is reused after recycling', () => {
    const bus = new LiveTaskStreamBus()

    pushRun(bus, 'call-1', { terminate: true })
    bus.push({ type: 'stdout', toolCallId: 'call-1', chunk: 'again\n', ts: 0 })

    expect(bus.getSnapshot('call-1')).toEqual({
      stdout: 'again\n',
      stderr: '',
      status: 'starting',
    })
  })
})
