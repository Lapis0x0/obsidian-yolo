// which.test.ts — 跨平台 PATH/PATHEXT 解析测试
//
// 注意：测试在主机平台（如 darwin/linux）跑，`path.delimiter` 与 `path.join`
// 的语义保持主机平台行为，与我们用 Object.defineProperty 改的 process.platform
// 无关。因此构造路径时不要包含主机 path.delimiter（POSIX 是 ':'），
// 否则 split(env.PATH) 时会被错切。下面用不含分隔符的占位路径绕开。
/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */

import * as path from 'node:path'

import { which } from './which'

const mockExisting = new Set<string>()

jest.mock('node:fs/promises', () => ({
  access: jest.fn().mockImplementation((p: string) => {
    if (mockExisting.has(p)) return Promise.resolve()
    return Promise.reject(new Error('ENOENT'))
  }),
  constants: { X_OK: 1 },
}))

beforeEach(() => {
  mockExisting.clear()
})

describe('which — POSIX', () => {
  const origPlatform = process.platform
  beforeAll(() => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    })
  })
  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: origPlatform,
      configurable: true,
    })
  })

  it('PATH 大写命中', async () => {
    mockExisting.add(path.join('/usr/local/bin', 'codex'))
    const result = await which('codex', {
      PATH: ['/opt/x', '/usr/local/bin'].join(path.delimiter),
    })
    expect(result).toBe(path.join('/usr/local/bin', 'codex'))
  })

  it('PATH 缺失返回 null', async () => {
    const result = await which('codex', {})
    expect(result).toBeNull()
  })
})

describe('which — Windows', () => {
  const origPlatform = process.platform
  beforeAll(() => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    })
  })
  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: origPlatform,
      configurable: true,
    })
  })

  it('小写 Path 也能命中（Windows 大小写不敏感兜底）', async () => {
    // 注意 ext 用大写 .CMD 与 which.ts 内部遍历顺序一致（PATHEXT 默认全大写）。
    // 文件系统在 Windows 大小写不敏感，但这里我们 mock access，需字符串一致。
    const dir = '/fake/npm'
    const candidate = path.join(dir, 'claude.CMD')
    mockExisting.add(candidate)
    const result = await which('claude', {
      Path: dir, // 小写 Path 而非 PATH
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    })
    expect(result).toBe(candidate)
  })

  it('全小写 path / pathext 也能命中', async () => {
    const dir = '/fake/npm2'
    const candidate = path.join(dir, 'codex.cmd')
    mockExisting.add(candidate)
    const result = await which('codex', {
      path: dir,
      pathext: '.com;.exe;.bat;.cmd', // 小写 pathext，which 不会做大小写规范化，按字面遍历
    })
    expect(result).toBe(candidate)
  })

  it('PATHEXT 缺失时使用默认扩展名集 .COM;.EXE;.BAT;.CMD', async () => {
    const dir = '/fake/bin'
    const candidate = path.join(dir, 'claude.EXE')
    mockExisting.add(candidate)
    const result = await which('claude', {
      PATH: dir,
    })
    expect(result).toBe(candidate)
  })

  it('无任何变体的 PATH — 返回 null', async () => {
    const result = await which('codex', { PATHEXT: '.EXE' })
    expect(result).toBeNull()
  })

  it('PATH 为空字符串但 Path 有值 — 跳过空串使用 Path', async () => {
    const dir = '/fake/binx'
    const candidate = path.join(dir, 'codex.CMD')
    mockExisting.add(candidate)
    const result = await which('codex', {
      PATH: '', // 空串需被跳过
      Path: dir,
      PATHEXT: '.CMD',
    })
    expect(result).toBe(candidate)
  })
})
