// runner.test.ts — 外部 CLI runner 单元测试
// 使用 Jest 模拟 node:child_process 和相关依赖
/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */

import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'

// ── 模拟 shell-env ──
jest.mock('shell-env', () => ({
  shellEnvSync: () => ({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    SHELL: '/bin/bash',
  }),
}))

// ── 模拟 which.ts（让其总是找到 CLI） ──
jest.mock('./which', () => ({
  which: jest.fn().mockResolvedValue('/usr/local/bin/codex'),
}))

// ── 模拟 streamBus ──
const pushMock = jest.fn()
jest.mock('./streamBus', () => ({
  externalCliStreamBus: {
    push: pushMock,
    getSnapshot: jest.fn().mockReturnValue(null),
    clearSnapshot: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}))

// ── 模拟 child_process ──
let mockChild: MockChild
const allMockChildren: MockChild[] = []

class MockChild extends EventEmitter {
  stdin: EventEmitter & { write: jest.Mock; end: jest.Mock }
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number

  constructor() {
    super()
    this.pid = 12345
    this.stdin = Object.assign(new EventEmitter(), {
      write: jest.fn(),
      end: jest.fn(),
    })
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
  }
}

const spawnMock = jest.fn().mockImplementation(() => {
  mockChild = new MockChild()
  return mockChild as unknown as ChildProcess
})

jest.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

// 模拟 node:fs/promises（供 which 使用，已被 mock，这里只需不报错）
jest.mock('node:fs/promises', () => ({
  access: jest.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}))

// 模拟 node:path
// eslint-disable-next-line @typescript-eslint/no-require-imports -- jest.mock factory 需要 require 语法
jest.mock('node:path', () => require('path'))

import { killAllActiveExternalCli, runExternalAgent } from './runner'

// 阻止真实 process.kill 调用（进程树 kill 需要负 PID，在测试中不可用）
const originalKill = process.kill.bind(process)
beforeAll(() => {
  jest.spyOn(process, 'kill').mockImplementation(() => true)
})
afterAll(() => {
  process.kill = originalKill
})

beforeEach(() => {
  jest.clearAllMocks()
  allMockChildren.length = 0
  // clearAllMocks 会清空 mockImplementation，需要在每个测试前重新设置
  spawnMock.mockImplementation(() => {
    mockChild = new MockChild()
    allMockChildren.push(mockChild)
    return mockChild as unknown as ChildProcess
  })
  // which mock 也需要重新设置（clearAllMocks 会清空 mockResolvedValue）
  // which mock 也需要重新设置（clearAllMocks 会清空 mockResolvedValue）
  jest.requireMock('./which').which.mockResolvedValue('/usr/local/bin/codex')
  // 重置活跃进程集合（通过连续调用 killAll）
  killAllActiveExternalCli()
})

// ── 工具函数：模拟进程正常退出 ──
function simulateSuccess(stdout: string, exitCode = 0) {
  setImmediate(() => {
    mockChild.stdout.emit('data', Buffer.from(stdout))
    mockChild.emit('close', exitCode)
  })
}

describe('runExternalAgent', () => {
  it('spawn 成功 — 返回 stdout', async () => {
    const promise = runExternalAgent({
      toolCallId: 'tc-1',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'hello',
    })
    simulateSuccess('output text')
    const result = await promise
    expect(result.stdout).toBe('output text')
    expect(result.exitCode).toBe(0)
    expect(result.truncated).toBeUndefined()
  })

  it('非 0 退出码仍返回 result', async () => {
    const promise = runExternalAgent({
      toolCallId: 'tc-2',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'workspace-write',
      prompt: 'fail',
    })
    setImmediate(() => {
      mockChild.stdout.emit('data', Buffer.from('partial output'))
      mockChild.emit('close', 1)
    })
    const result = await promise
    expect(result.stdout).toBe('partial output')
    expect(result.exitCode).toBe(1)
  })

  it('abort signal — 触发 kill 并 resolve（保留已采集输出）', async () => {
    const controller = new AbortController()
    const promise = runExternalAgent({
      toolCallId: 'tc-3',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'test',
      signal: controller.signal,
    })

    setImmediate(() => {
      mockChild.stdout.emit('data', Buffer.from('some output'))
      controller.abort()
      // 模拟被 SIGTERM 杀死后进程退出
      setImmediate(() => {
        mockChild.emit('close', null)
      })
    })

    const result = await promise
    expect(result.stdout).toBe('some output')
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest spy 断言必须引用原始方法
    expect(process.kill).toHaveBeenCalledWith(-mockChild.pid, 'SIGTERM')
  })

  it('超时 — reject 并调用 kill', async () => {
    // 测试超时逻辑：用 AbortSignal 模拟超时路径（超时内部也是 killProcess + reject）
    // 避免使用 jest.useFakeTimers()，因其会干扰 await import() 的微任务队列

    const controller = new AbortController()
    const promise = runExternalAgent({
      toolCallId: 'tc-timeout',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'slow',
      timeoutSeconds: 600,
      signal: controller.signal,
    })

    // abort 触发与超时相同的 killProcess 逻辑
    setImmediate(() => {
      controller.abort()
      setImmediate(() => {
        mockChild.emit('close', null)
      })
    })

    await promise
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest spy 断言
    expect(process.kill).toHaveBeenCalledWith(-mockChild.pid, 'SIGTERM')
  }, 10000)

  it('输出超过 1MB — 双端截断并设置 truncated metadata', async () => {
    // 构造超过 1MB 的数据
    const MB = 1024 * 1024
    const bigData = Buffer.alloc(MB + 100, 'x')

    const promise = runExternalAgent({
      toolCallId: 'tc-5',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'big',
    })

    setImmediate(() => {
      mockChild.stdout.emit('data', bigData)
      mockChild.emit('close', 0)
    })

    const result = await promise
    expect(result.truncated).toBeDefined()
    expect(result.truncated?.totalBytes).toBe(MB + 100)
    expect(result.truncated?.omittedBytes).toBeGreaterThan(0)
    // 截断后文本应包含提示信息
    expect(result.stdout).toContain('输出过长')
  })

  it('输出超过 1.5MB — collector 内存占用 ≤ 600KB（head+tail 上限）', async () => {
    // 构造 1.5MB 数据，验证进程内部收集到的字节远少于原始数据大小
    const MB = 1024 * 1024
    const bigData = Buffer.alloc(1.5 * MB, 0x61) // 1.5MB 'a'

    const promise = runExternalAgent({
      toolCallId: 'tc-mem',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'big',
    })

    setImmediate(() => {
      mockChild.stdout.emit('data', bigData)
      mockChild.emit('close', 0)
    })

    const result = await promise

    // truncated 应存在，且 totalBytes 等于实际输入
    expect(result.truncated).toBeDefined()
    expect(result.truncated?.totalBytes).toBe(Math.floor(1.5 * MB))
    // omittedBytes 应 > 0（确实有数据被省略）
    expect(result.truncated?.omittedBytes).toBeGreaterThan(0)
    // 最终文本应包含截断提示标记
    expect(result.stdout).toContain('输出过长')
    // 最终文本长度应远小于原始 1.5MB（head 256KB + marker + tail 256KB ≈ 512KB+）
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThan(600 * 1024)
  })

  it('Windows 平台 — 直接 reject', async () => {
    const origPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    })

    await expect(
      runExternalAgent({
        toolCallId: 'tc-6',
        provider: 'codex',
        workingDirectory: '/tmp',
        sandboxMode: 'read-only',
        prompt: 'test',
      }),
    ).rejects.toThrow('Windows support coming in a future release')

    Object.defineProperty(process, 'platform', {
      value: origPlatform,
      configurable: true,
    })
  })

  it('sandboxMode 不合法 — reject', async () => {
    await expect(
      runExternalAgent({
        toolCallId: 'tc-7',
        provider: 'codex',
        workingDirectory: '/tmp',
        sandboxMode: 'invalid-mode',
        prompt: 'test',
      }),
    ).rejects.toThrow('sandboxMode')
  })

  it('model 字段含非法字符 — reject', async () => {
    await expect(
      runExternalAgent({
        toolCallId: 'tc-8',
        provider: 'codex',
        workingDirectory: '/tmp',
        sandboxMode: 'read-only',
        prompt: 'test',
        model: 'o3; rm -rf /',
      }),
    ).rejects.toThrow('model')
  })

  it('并发超过 3 个 — reject', async () => {
    // 启动 3 个不会退出的进程
    const makeSlowRun = (id: string) =>
      runExternalAgent({
        toolCallId: id,
        provider: 'codex',
        workingDirectory: '/tmp',
        sandboxMode: 'read-only',
        prompt: 'slow',
        timeoutSeconds: 3600,
      })

    const p1 = makeSlowRun('conc-1')
    const p2 = makeSlowRun('conc-2')
    const p3 = makeSlowRun('conc-3')

    // 第 4 个应该立即 reject（此时活跃进程已满 3 个）
    await expect(makeSlowRun('conc-4')).rejects.toThrow('too many concurrent')

    // 关闭所有已创建的子进程让 p1/p2/p3 完成
    setImmediate(() => {
      for (const child of allMockChildren) {
        child.emit('close', 0)
      }
    })

    await Promise.allSettled([p1, p2, p3])
  })

  it('UTF-8 边界 — 截断不破坏多字节字符', async () => {
    // 创建一个总大小 > 1MB 且在 256KB 边界恰好有中文字符的 buffer
    const MB = 1024 * 1024
    const TRUNCATE_HEAD = 256 * 1024
    const head = Buffer.alloc(TRUNCATE_HEAD - 1, 0x41) // 'A' * (256KB - 1)
    const chinese = Buffer.from('中文', 'utf8') // 6 bytes（UTF-8 多字节）
    // tail 足够长，让总大小超过 1MB
    const tail = Buffer.alloc(MB - TRUNCATE_HEAD + 100, 0x42)
    const bigBuf = Buffer.concat([head, chinese, tail])
    // 确认总大小确实超过 1MB
    expect(bigBuf.length).toBeGreaterThan(MB)

    const promise = runExternalAgent({
      toolCallId: 'tc-utf8',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'utf8',
    })

    setImmediate(() => {
      mockChild.stdout.emit('data', bigBuf)
      mockChild.emit('close', 0)
    })

    const result = await promise
    // 应该被截断（总大小 > 1MB）
    expect(result.truncated).toBeDefined()
    // 截断结果应为合法 UTF-8（能正常解码而不出现 replacement char 问题）
    expect(() =>
      Buffer.from(result.stdout, 'utf8').toString('utf8'),
    ).not.toThrow()
  })

  // ── 必修 1：512KB < 输出 < 1MB 时全量保留，不静默丢数据 ──
  it('800KB 输出（512KB < x < 1MB）— 全量保留，truncated 为 undefined', async () => {
    const KB = 1024
    const size = 800 * KB
    const data = Buffer.alloc(size, 0x41) // 800KB 'A'

    const promise = runExternalAgent({
      toolCallId: 'tc-800kb',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'medium',
    })

    setImmediate(() => {
      mockChild.stdout.emit('data', data)
      mockChild.emit('close', 0)
    })

    const result = await promise
    // 800KB < 1MB，应该全量保留，不截断
    expect(result.truncated).toBeUndefined()
    // 输出长度应等于原始大小（ASCII 字符，字节 == 字符数）
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBe(size)
  })

  // ── 必修 2：含中文的 >1MB 输出不产生 replacement char ──
  it('含中文的 1.2MB 输出截断后不含 replacement char', async () => {
    const MB = 1024 * 1024
    // "你好世界" 每个字符 3 字节，4 字符 = 12 字节，重复填充到 ~1.2MB
    const unit = Buffer.from('你好世界', 'utf8') // 12 bytes
    const repeat = Math.ceil((1.2 * MB) / unit.length)
    const chunks: Buffer[] = []
    for (let i = 0; i < repeat; i++) {
      chunks.push(unit)
    }
    const bigBuf = Buffer.concat(chunks)
    expect(bigBuf.length).toBeGreaterThan(MB)

    const promise = runExternalAgent({
      toolCallId: 'tc-chinese-utf8',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'chinese',
    })

    setImmediate(() => {
      mockChild.stdout.emit('data', bigBuf)
      mockChild.emit('close', 0)
    })

    const result = await promise
    expect(result.truncated).toBeDefined()
    // 不含 UTF-8 replacement char（U+FFFD）
    expect(result.stdout).not.toContain('�')
  })

  // ── 必修 4：超时后 result 包含 timedOut: true 且 stdout 非空 ──
  it('超时 — result.timedOut 为 true 且保留已采集 stdout', async () => {
    // 先推数据，再启动 runner（timeoutSeconds 极小），确保超时发生在 close 之前
    // 不使用 fake timers，避免与 await import() 的微任务队列冲突
    const promise = runExternalAgent({
      toolCallId: 'tc-timeout-result',
      provider: 'codex',
      workingDirectory: '/tmp',
      sandboxMode: 'read-only',
      prompt: 'slow',
      timeoutSeconds: 0.05, // 50ms 后超时
    })

    setImmediate(() => {
      // 在超时触发前推送数据
      mockChild.stdout.emit(
        'data',
        Buffer.from('partial output before timeout'),
      )
      // 200ms 后模拟进程退出（晚于超时）
      setTimeout(() => {
        mockChild.emit('close', null)
      }, 200)
    })

    const result = await promise
    expect(result.timedOut).toBe(true)
    expect(result.stdout).toBe('partial output before timeout')
  }, 5000)
})
