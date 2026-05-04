// streamBus.test.ts — 外部 CLI stream bus 单元测试

import { ExternalCliStreamBus } from './streamBus'

describe('ExternalCliStreamBus', () => {
  it('snapshot 超过 SNAPSHOT_MAX_CHARS 时从前端截断', () => {
    const bus = new ExternalCliStreamBus()

    // 推送 5MB 的 chunk（单次）
    const fiveMB = 'x'.repeat(5 * 1024 * 1024)
    bus.push({ type: 'stdout', toolCallId: 'tc-snap', chunk: fiveMB, ts: 0 })

    const snap = bus.getSnapshot('tc-snap')
    expect(snap).not.toBeNull()
    // snapshot 长度应 <= SNAPSHOT_MAX_CHARS + marker 长度 + 1024 容差
    const SNAPSHOT_MAX_CHARS = 1 * 1024 * 1024
    const MARKER = '... [front truncated] ...\n'
    expect(snap!.stdout.length).toBeLessThanOrEqual(
      SNAPSHOT_MAX_CHARS + MARKER.length + 1024,
    )
    // 内容应包含截断 marker
    expect(snap!.stdout).toContain('[front truncated]')
  })

  it('snapshot 未超限时内容完整', () => {
    const bus = new ExternalCliStreamBus()

    bus.push({ type: 'stdout', toolCallId: 'tc-small', chunk: 'hello', ts: 0 })
    bus.push({ type: 'stdout', toolCallId: 'tc-small', chunk: ' world', ts: 1 })

    const snap = bus.getSnapshot('tc-small')
    expect(snap?.stdout).toBe('hello world')
  })

  it('stderr 同样受 capped 保护', () => {
    const bus = new ExternalCliStreamBus()

    const fiveMB = 'e'.repeat(5 * 1024 * 1024)
    bus.push({ type: 'stderr', toolCallId: 'tc-err', chunk: fiveMB, ts: 0 })

    const snap = bus.getSnapshot('tc-err')
    const SNAPSHOT_MAX_CHARS = 1 * 1024 * 1024
    const MARKER = '... [front truncated] ...\n'
    expect(snap!.stderr.length).toBeLessThanOrEqual(
      SNAPSHOT_MAX_CHARS + MARKER.length + 1024,
    )
  })
})
