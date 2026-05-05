// 外部 CLI 子进程执行器
//
// 此模块由 external-cli/index.ts 在 Platform.isDesktop 守卫后通过
// `await import('./runner')` 懒加载，因此对 mobile 不可达。可以顶级静态 import
// node 内置模块（esbuild 已外部化为 require）；不要改用 dynamic `await import('node:...')`，
// 那会被 cjs 输出保留为 ES dynamic import 并在 Electron renderer 里失败：
// "Failed to fetch dynamically imported module: node:xxx"
/* eslint-disable import/no-nodejs-modules -- desktop-only module, lazy-loaded behind Platform.isDesktop */
import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
/* eslint-enable import/no-nodejs-modules */

import { shellEnvSync } from 'shell-env'

import type { TaskSource } from '../../../types/chat'

import { type AsyncTaskRecord, asyncTaskRegistry } from './async-task-registry'
import { ClaudeStreamParser } from './claudeStreamParser'
import { externalCliStreamBus } from './streamBus'
import { stripAnsi } from './stripAnsi'
import { which } from './which'

// ────────── 常量 ──────────
const MAX_OUTPUT_BYTES = 1 * 1024 * 1024 // 1MB
const TRUNCATE_HEAD_BYTES = 256 * 1024 // 256KB
const TRUNCATE_TAIL_BYTES = 256 * 1024 // 256KB
const MAX_CONCURRENT = 3
const SIGKILL_DELAY_MS = 3000

// codex 允许的 sandboxMode 枚举
const CODEX_SANDBOX_MODES = new Set([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

// claude-code 允许的 sandboxMode 枚举
const CLAUDE_SANDBOX_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
])

// model 字段白名单正则
const MODEL_PATTERN = /^[A-Za-z0-9._-]+$/

// ────────── 类型 ──────────
export type ExternalAgentProvider = 'codex' | 'claude-code'

export type RunExternalAgentParams = {
  toolCallId: string
  provider: ExternalAgentProvider
  workingDirectory: string
  sandboxMode: string
  prompt: string
  model?: string
  timeoutSeconds?: number
  signal?: AbortSignal
  /** 执行模式；默认 sync */
  mode?: 'sync' | 'async'
  /** async 模式必需：任务唯一 ID */
  taskId?: string
  /** async 模式必需：关联的会话 ID */
  conversationId?: string
  /** async 模式必需：任务来源 */
  source?: TaskSource
  /** async 模式：供 UI 显示的短标题（从 prompt 截取） */
  title?: string
}

export type AsyncPlaceholderResult = {
  accepted: true
  taskId: string
  title: string
  provider: ExternalAgentProvider
  status: 'running'
  note: string
}

export type RunExternalAgentResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  /** stdout 双端截断元数据；未截断时为 undefined */
  truncated?: {
    totalBytes: number
    omittedBytes: number
  }
  /** stderr 双端截断元数据；未截断时为 undefined */
  stderrTruncated?: {
    totalBytes: number
    omittedBytes: number
  }
  timedOut?: boolean
}

// ────────── 活跃进程集合（供 plugin unload 清理） ──────────
const activeProcesses = new Set<() => void>()

/** plugin unload 时调用，杀光所有活跃子进程 */
export function killAllActiveExternalCli(): void {
  for (const killFn of activeProcesses) {
    try {
      killFn()
    } catch {
      // 忽略单个失败，继续清理其他
    }
  }
  activeProcesses.clear()
}

// ────────── UTF-8 safe 字节截断 ──────────

/**
 * 修剪 Buffer 末尾不完整的 UTF-8 多字节序列。
 * 从末尾找到最后一个起始字节（leading byte），检查其需要的 continuation bytes
 * 是否完整；若不完整则截掉整个序列。
 *
 * 用于 buf.length <= maxBytes 时也需要保证末尾合法的场景（如采集阶段 chunk 被切断）。
 */
function trimUtf8End(buf: Buffer): Buffer {
  let end = buf.length
  // 从后往前跳过 continuation bytes，找最后一个起始字节
  let i = end - 1
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) {
    i--
  }
  if (i < 0) return buf.subarray(0, 0)
  // 检查最后一个起始字节需要多少 continuation bytes
  const lead = buf[i]
  let expectedLen = 1
  if ((lead & 0x80) === 0x00) expectedLen = 1
  else if ((lead & 0xe0) === 0xc0) expectedLen = 2
  else if ((lead & 0xf0) === 0xe0) expectedLen = 3
  else if ((lead & 0xf8) === 0xf0) expectedLen = 4
  const actualCont = end - 1 - i // 实际跟在起始字节后面的连续字节数
  const neededCont = expectedLen - 1
  if (actualCont < neededCont) {
    // 序列不完整，截掉这个起始字节及其不足的 continuation bytes
    end = i
  }
  return buf.subarray(0, end)
}

/**
 * 将 Buffer 截断到 maxBytes，并确保截断点是合法 UTF-8 字符边界。
 *
 * 若截断点落在 continuation byte 上，向前回退到该多字节序列的起始字节，
 * 然后截掉整个序列（保守截断，确保末尾是完整字符）。
 *
 * 若 buf.length <= maxBytes，则调用 trimUtf8End 修剪末尾可能的不完整序列。
 */
function trimToUtf8Boundary(buf: Buffer, maxBytes: number): Buffer {
  if (buf.length <= maxBytes) {
    return trimUtf8End(buf)
  }
  // 截断点可能落在 continuation byte 上，向前找起始字节
  let cutAt = maxBytes
  while (cutAt > 0 && (buf[cutAt] & 0xc0) === 0x80) {
    cutAt--
  }
  return buf.subarray(0, cutAt)
}

/**
 * 从前端跳过 continuation byte，找到第一个合法的 UTF-8 字符起始位置。
 * 防止 tail 前端出现半截多字节字符导致 toString 出现 replacement char。
 */
function trimUtf8Front(buf: Buffer): Buffer {
  let start = 0
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++
  }
  return buf.subarray(start)
}

/**
 * 流式采集器：
 * - 当 totalBytes <= MAX_OUTPUT_BYTES 时：全量保留所有 chunks，finalize 直接拼接。
 * - 一旦 totalBytes 超过 MAX_OUTPUT_BYTES：切换到 head+tail 双端模式，
 *   内存稳态上限 ≈ TRUNCATE_HEAD_BYTES + TRUNCATE_TAIL_BYTES（512KB）。
 *
 * 语义保证：≤ MAX_OUTPUT_BYTES 的输出全量返回，不丢数据；
 *           > MAX_OUTPUT_BYTES 才进行双端截断并标记 truncated metadata。
 */
class CappedOutputCollector {
  // 全量模式：totalBytes <= MAX_OUTPUT_BYTES 时使用
  private fullChunks: Buffer[] = []
  // 双端模式：超过 MAX_OUTPUT_BYTES 后使用
  private headChunks: Buffer[] = []
  private tailChunks: Buffer[] = []
  private tailBytes = 0
  // 是否已进入双端模式
  private capped = false
  totalBytes = 0

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length

    if (!this.capped) {
      if (this.totalBytes <= MAX_OUTPUT_BYTES) {
        // 全量模式：直接追加
        this.fullChunks.push(chunk)
        return
      }
      // 首次超过 MAX_OUTPUT_BYTES：把已收集 chunks **加上当前 chunk** 一起当作"目前为止全部"
      // 来切分，否则首个大 chunk 触发跨阈值时 head 会是空的。
      this.capped = true
      const allSoFar = Buffer.concat([...this.fullChunks, chunk])
      this.fullChunks = []
      // 填充 head（最多 TRUNCATE_HEAD_BYTES）
      const headPart = allSoFar.subarray(0, TRUNCATE_HEAD_BYTES)
      this.headChunks.push(headPart)
      // 剩余部分放入 tail，复用 _trimTail 控制上限
      if (allSoFar.length > TRUNCATE_HEAD_BYTES) {
        const leftover = allSoFar.subarray(TRUNCATE_HEAD_BYTES)
        this.tailChunks.push(leftover)
        this.tailBytes = leftover.length
        this._trimTail()
      }
      return
    }

    // 双端模式：head 已满，新 chunk 直接进 tail
    this.tailChunks.push(chunk)
    this.tailBytes += chunk.length
    this._trimTail()
  }

  private _trimTail(): void {
    // 从前面 shift 直到 tailBytes <= TRUNCATE_TAIL_BYTES
    while (this.tailBytes > TRUNCATE_TAIL_BYTES && this.tailChunks.length > 0) {
      const front = this.tailChunks[0]
      if (this.tailBytes - front.length >= TRUNCATE_TAIL_BYTES) {
        // 整块丢弃
        this.tailBytes -= front.length
        this.tailChunks.shift()
      } else {
        // 部分丢弃：只保留尾部
        const keep = TRUNCATE_TAIL_BYTES - (this.tailBytes - front.length)
        this.tailChunks[0] = front.subarray(front.length - keep)
        this.tailBytes = TRUNCATE_TAIL_BYTES
        break
      }
    }
  }

  finalize(): {
    text: string
    truncated?: { totalBytes: number; omittedBytes: number }
  } {
    if (!this.capped) {
      // 全量模式：直接拼接，不截断
      const text = Buffer.concat(this.fullChunks).toString('utf8')
      return { text }
    }

    // 双端模式：修剪 UTF-8 边界后拼接
    const headBuf = trimToUtf8Boundary(
      Buffer.concat(this.headChunks),
      TRUNCATE_HEAD_BYTES,
    )
    const rawTail = Buffer.concat(this.tailChunks)
    // 修剪 tail 前端的 continuation byte，防止拼接后出现 replacement char
    const tailBuf = trimToUtf8Boundary(
      trimUtf8Front(rawTail),
      TRUNCATE_TAIL_BYTES,
    )

    const omittedBytes = this.totalBytes - headBuf.length - tailBuf.length
    const marker = `\n\n... [输出过长，中间 ${omittedBytes} 字节已省略] ...\n\n`
    const text = headBuf.toString('utf8') + marker + tailBuf.toString('utf8')
    return { text, truncated: { totalBytes: this.totalBytes, omittedBytes } }
  }
}

// 从 prompt 截取短标题（去换行合并空白，最多 60 字符）
function deriveTitleFromPrompt(prompt: string): string {
  return prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
}

// ────────── 主函数 ──────────
export async function runExternalAgent(
  params: RunExternalAgentParams,
): Promise<RunExternalAgentResult | AsyncPlaceholderResult> {
  const {
    toolCallId,
    provider,
    workingDirectory,
    sandboxMode,
    prompt,
    model,
    timeoutSeconds,
    signal: externalSignal,
    mode,
    taskId,
    conversationId,
    source,
    title,
  } = params

  // ── 平台守卫 ──
  if (process.platform === 'win32') {
    throw new Error('Windows support coming in a future release')
  }

  // ── signal.aborted 早检查（必修 5）──
  if (externalSignal?.aborted) {
    throw new Error('Aborted before start')
  }

  // ── sandboxMode 枚举校验（提前到占槽之前，避免 placeholder 泄漏，必修 6）──
  const allowedSandboxModes =
    provider === 'codex' ? CODEX_SANDBOX_MODES : CLAUDE_SANDBOX_MODES
  if (!allowedSandboxModes.has(sandboxMode)) {
    throw new Error(
      `sandboxMode "${sandboxMode}" is not valid for provider "${provider}". ` +
        `Allowed: ${[...allowedSandboxModes].join(', ')}`,
    )
  }

  // ── model 字段校验（提前到占槽之前，避免 placeholder 泄漏，必修 6）──
  if (model !== undefined && !MODEL_PATTERN.test(model)) {
    throw new Error(
      `model "${model}" contains invalid characters. Only [A-Za-z0-9._-] are allowed.`,
    )
  }

  // ── workingDirectory 校验：必须是绝对路径，且指向存在的目录 ──
  // 在并发占槽之前抛错，避免泄漏占槽；错误信息明确，避免 spawn 报 ENOENT 时
  // 把锅甩给 cli 二进制路径（实际 cwd 不存在）造成误导。
  if (!isAbsolute(workingDirectory)) {
    throw new Error(
      `workingDirectory must be an absolute path: ${workingDirectory}`,
    )
  }
  try {
    const stats = await stat(workingDirectory)
    if (!stats.isDirectory()) {
      throw new Error(
        `workingDirectory is not a directory: ${workingDirectory}`,
      )
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.startsWith('workingDirectory is not a directory')
    ) {
      throw err
    }
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`workingDirectory does not exist: ${workingDirectory}`)
    }
    if (code === 'EACCES') {
      throw new Error(
        `workingDirectory is not accessible (permission denied): ${workingDirectory}`,
      )
    }
    throw new Error(
      `Failed to access workingDirectory "${workingDirectory}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }

  // ── 并发上限（先占槽再 await，避免并发调用同时通过检查）──
  if (activeProcesses.size >= MAX_CONCURRENT) {
    throw new Error('too many concurrent external agents (max 3)')
  }
  // 在第一个 await 之前立即占槽（placeholder），后续替换为真实 kill 函数
  const placeholder: () => void = () => {}
  activeProcesses.add(placeholder)

  // 占槽之后所有路径（含 await 与同步 throw）必须保证 placeholder 释放，
  // 否则连续启动失败会塞满并发槽。统一用一个 try 包到替换为 killProcess 为止。
  let env: NodeJS.ProcessEnv
  let cliPath: string | null
  try {
    // ── 加载 shell env ──
    env = shellEnvSync()

    // ── 查找 CLI 可执行文件 ──
    const cliName = provider === 'codex' ? 'codex' : 'claude'
    cliPath = await which(cliName, env)
    if (!cliPath) {
      throw new Error(
        `CLI "${cliName}" not found in PATH. ` +
          `Please ensure it is installed and available. ` +
          `Current PATH: ${env.PATH ?? '(empty)'}`,
      )
    }
  } catch (err) {
    activeProcesses.delete(placeholder)
    throw err
  }

  // ── 构造命令参数 ──
  const modelArgs: string[] = model ? ['--model', model] : []

  let args: string[]
  if (provider === 'codex') {
    args = [
      'exec',
      '--sandbox',
      sandboxMode,
      '--skip-git-repo-check',
      ...modelArgs,
      '-', // prompt 通过 stdin 传入
    ]
  } else {
    // claude-code：启用 stream-json 模式以获取实时进度
    args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      sandboxMode,
      ...modelArgs,
    ]
  }

  // ── 初始化流式总线状态 ──
  externalCliStreamBus.push({ type: 'status', toolCallId, status: 'starting' })

  // ── spawn 与 stdin.write 也必须释放 placeholder，否则 spawn 同步抛错
  // / pipe 错误都会泄漏并发槽。 ──
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(cliPath, args, {
      cwd: workingDirectory,
      env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // 向 stdin 写入 prompt，写完立即关闭防止死锁
    if (child.stdin) {
      child.stdin.write(prompt, 'utf8')
      child.stdin.end()
    }
  } catch (err) {
    activeProcesses.delete(placeholder)
    throw err
  }

  externalCliStreamBus.push({ type: 'status', toolCallId, status: 'running' })

  // ── async 模式：注册 registry，最终 resolve 后在后台继续跑 ──
  const isAsync = mode === 'async'
  const resolvedTitle = title ?? deriveTitleFromPrompt(prompt)

  let asyncRecord: AsyncTaskRecord | undefined
  let effectiveSignal = externalSignal
  if (isAsync && taskId && conversationId && source) {
    const abortController = new AbortController()
    // 如果外部传了 signal，串联到我们自己的 abortController
    externalSignal?.addEventListener('abort', () => abortController.abort(), {
      once: true,
    })
    asyncRecord = {
      taskId,
      source,
      conversationId,
      provider,
      title: resolvedTitle,
      status: 'running',
      createdAt: Date.now(),
      stdoutBuffer: '',
      stderrBuffer: '',
      exitCode: null,
      abortController,
    }
    asyncTaskRegistry.register(asyncRecord)
    // 用 asyncRecord 的 abortController.signal 作为进程中止信号
    effectiveSignal = abortController.signal
  }

  // ── 采集输出（字节级，内存上限 ≈ 512KB per stream） ──
  const stderrCollector = new CappedOutputCollector()

  if (provider === 'codex') {
    // codex：stdout 直接作为最终结果文本
    const stdoutCollector = new CappedOutputCollector()

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutCollector.push(chunk)
      externalCliStreamBus.push({
        type: 'stdout',
        toolCallId,
        chunk: stripAnsi(chunk.toString('utf8')),
        ts: Date.now(),
      })
      if (asyncRecord) {
        asyncRecord.stdoutBuffer += stripAnsi(chunk.toString('utf8'))
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrCollector.push(chunk)
      externalCliStreamBus.push({
        type: 'stderr',
        toolCallId,
        chunk: stripAnsi(chunk.toString('utf8')),
        ts: Date.now(),
      })
      if (asyncRecord) {
        asyncRecord.stderrBuffer += stripAnsi(chunk.toString('utf8'))
      }
    })

    // ── 进程树 kill 函数 ──
    let killTimer: ReturnType<typeof setTimeout> | null = null
    const killProcess = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        // 进程可能已退出，忽略
      }
      killTimer = setTimeout(() => {
        if (child.pid === undefined) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          // 已退出，忽略
        }
      }, SIGKILL_DELAY_MS)
    }

    // 将占位符替换为真实 kill 函数
    activeProcesses.delete(placeholder)
    activeProcesses.add(killProcess)

    // ── 后台完成处理（async 模式 close 后 emit task-completed）──
    const handleClose = (code: number | null, timedOut: boolean) => {
      if (!asyncRecord) return
      const { text: stdoutText } = stdoutCollector.finalize()
      const { text: stderrText } = stderrCollector.finalize()
      const completedAt = Date.now()

      let finalStatus: AsyncTaskRecord['status']
      if (asyncRecord.abortController.signal.aborted) {
        // 判断是 plugin unload 导致的 abortAll 还是用户主动取消
        finalStatus = 'cancelled'
      } else if (timedOut) {
        finalStatus = 'timed_out'
      } else if (code === 0) {
        finalStatus = 'completed'
      } else {
        finalStatus = 'failed'
      }

      asyncTaskRegistry.update(asyncRecord.taskId, {
        status: finalStatus,
        completedAt,
        stdoutBuffer: stdoutText,
        stderrBuffer: stderrText,
        exitCode: code,
      })

      const updatedRecord = asyncTaskRegistry.get(asyncRecord.taskId)
      if (updatedRecord) {
        externalCliStreamBus.push({
          type: 'task-completed',
          taskId: asyncRecord.taskId,
          conversationId: asyncRecord.conversationId,
          record: updatedRecord,
        })
      }
    }

    // ── 返回 Promise ──
    const syncPromise = new Promise<RunExternalAgentResult>(
      (resolve, reject) => {
        let timedOut = false
        const timeoutId: ReturnType<typeof setTimeout> | undefined =
          timeoutSeconds !== undefined
            ? setTimeout(() => {
                timedOut = true
                killProcess()
              }, timeoutSeconds * 1000)
            : undefined

        const onAbort = () => {
          killProcess()
          clearTimeout(timeoutId)
        }
        effectiveSignal?.addEventListener('abort', onAbort, { once: true })

        child.on('error', (err) => {
          clearTimeout(timeoutId)
          clearTimeout(killTimer ?? 0)
          effectiveSignal?.removeEventListener('abort', onAbort)
          activeProcesses.delete(killProcess)
          externalCliStreamBus.push({
            type: 'status',
            toolCallId,
            status: 'done',
          })
          if (asyncRecord) {
            handleClose(null, false)
          }
          reject(err)
        })

        child.on('close', (code) => {
          clearTimeout(timeoutId)
          if (killTimer) clearTimeout(killTimer)
          effectiveSignal?.removeEventListener('abort', onAbort)
          activeProcesses.delete(killProcess)
          externalCliStreamBus.push({
            type: 'status',
            toolCallId,
            status: 'done',
          })

          const { text: stdoutText, truncated } = stdoutCollector.finalize()
          const { text: stderrText, truncated: stderrTruncated } =
            stderrCollector.finalize()

          if (asyncRecord) {
            handleClose(code, timedOut)
          }

          resolve({
            stdout: stdoutText,
            stderr: stderrText,
            exitCode: code,
            truncated,
            stderrTruncated,
            ...(timedOut ? { timedOut: true } : {}),
          })
        })
      },
    )

    if (isAsync && asyncRecord) {
      // 后台跑，不 await；错误不上抛（子进程失败已通过 task-completed 事件传出）
      syncPromise.catch(() => {})
      return {
        accepted: true,
        taskId: asyncRecord.taskId,
        title: resolvedTitle,
        provider,
        status: 'running',
        note: 'Task started asynchronously. The result will arrive as a follow-up event when the subprocess completes.',
      } satisfies AsyncPlaceholderResult
    }

    return syncPromise
  }

  // ── claude-code 分支：stream-json 解析 ──
  const finalTextCollector = new CappedOutputCollector()

  const claudeParser = new ClaudeStreamParser({
    onProgress: (line) => {
      const progressChunk = line + '\n'
      stderrCollector.push(Buffer.from(progressChunk, 'utf8'))
      externalCliStreamBus.push({
        type: 'stderr',
        toolCallId,
        chunk: progressChunk,
        ts: Date.now(),
      })
      if (asyncRecord) {
        asyncRecord.stderrBuffer += progressChunk
      }
    },
    onText: (chunk) => {
      finalTextCollector.push(Buffer.from(chunk, 'utf8'))
      externalCliStreamBus.push({
        type: 'stdout',
        toolCallId,
        chunk,
        ts: Date.now(),
      })
      if (asyncRecord) {
        asyncRecord.stdoutBuffer += chunk
      }
    },
  })

  // 用 StringDecoder 流式解码，避免 Buffer 切在多字节字符（中文/emoji）中间产生 �。
  const stdoutDecoder = new StringDecoder('utf8')
  let parserFinished = false
  const finishParserOnce = () => {
    if (parserFinished) return
    parserFinished = true
    const tail = stdoutDecoder.end()
    if (tail) claudeParser.feed(tail)
    claudeParser.finish()
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    const text = stdoutDecoder.write(chunk)
    if (text) claudeParser.feed(text)
  })

  child.stdout?.on('end', () => {
    finishParserOnce()
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrCollector.push(chunk)
    externalCliStreamBus.push({
      type: 'stderr',
      toolCallId,
      chunk: stripAnsi(chunk.toString('utf8')),
      ts: Date.now(),
    })
  })

  // ── 进程树 kill 函数 ──
  let killTimer: ReturnType<typeof setTimeout> | null = null
  const killProcess = () => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      // 进程可能已退出，忽略
    }
    killTimer = setTimeout(() => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // 已退出，忽略
      }
    }, SIGKILL_DELAY_MS)
  }

  // 将占位符替换为真实 kill 函数
  activeProcesses.delete(placeholder)
  activeProcesses.add(killProcess)

  // ── 后台完成处理（async 模式 close 后 emit task-completed）──
  const handleCloseAsync = (code: number | null, timedOut: boolean) => {
    if (!asyncRecord) return
    const { text: stdoutText } = finalTextCollector.finalize()
    const { text: stderrText } = stderrCollector.finalize()
    const completedAt = Date.now()

    let finalStatus: AsyncTaskRecord['status']
    if (asyncRecord.abortController.signal.aborted) {
      finalStatus = 'cancelled'
    } else if (timedOut) {
      finalStatus = 'timed_out'
    } else if (code === 0) {
      finalStatus = 'completed'
    } else {
      finalStatus = 'failed'
    }

    asyncTaskRegistry.update(asyncRecord.taskId, {
      status: finalStatus,
      completedAt,
      stdoutBuffer: stdoutText,
      stderrBuffer: stderrText,
      exitCode: code,
    })

    const updatedRecord = asyncTaskRegistry.get(asyncRecord.taskId)
    if (updatedRecord) {
      externalCliStreamBus.push({
        type: 'task-completed',
        taskId: asyncRecord.taskId,
        conversationId: asyncRecord.conversationId,
        record: updatedRecord,
      })
    }
  }

  // ── 返回 Promise ──
  const claudeSyncPromise = new Promise<RunExternalAgentResult>(
    (resolve, reject) => {
      // 超时标志（必修 4）：不在 setTimeout 里 reject，让 close 事件正常 resolve。
      // 仅当显式传入 timeoutSeconds 时启用 timer；不传则不超时（劳务派遣类任务可能跑很久，由用户主动取消）。
      let timedOut = false
      const timeoutId: ReturnType<typeof setTimeout> | undefined =
        timeoutSeconds !== undefined
          ? setTimeout(() => {
              timedOut = true
              killProcess()
            }, timeoutSeconds * 1000)
          : undefined

      // 外部 abort signal
      const onAbort = () => {
        killProcess()
        // resolve（而非 reject）以便调用方获取已采集的输出
        clearTimeout(timeoutId)
      }
      effectiveSignal?.addEventListener('abort', onAbort, { once: true })

      child.on('error', (err) => {
        clearTimeout(timeoutId)
        clearTimeout(killTimer ?? 0)
        effectiveSignal?.removeEventListener('abort', onAbort)
        activeProcesses.delete(killProcess)
        finishParserOnce()
        externalCliStreamBus.push({
          type: 'status',
          toolCallId,
          status: 'done',
        })
        if (asyncRecord) {
          handleCloseAsync(null, false)
        }
        reject(err)
      })

      child.on('close', (code) => {
        clearTimeout(timeoutId)
        if (killTimer) clearTimeout(killTimer)
        effectiveSignal?.removeEventListener('abort', onAbort)
        activeProcesses.delete(killProcess)
        finishParserOnce()
        externalCliStreamBus.push({
          type: 'status',
          toolCallId,
          status: 'done',
        })

        const { text: stdoutText, truncated } = finalTextCollector.finalize()
        const { text: stderrText, truncated: stderrTruncated } =
          stderrCollector.finalize()

        if (asyncRecord) {
          handleCloseAsync(code, timedOut)
        }

        resolve({
          stdout: stdoutText,
          stderr: stderrText,
          exitCode: code,
          truncated,
          stderrTruncated,
          ...(timedOut ? { timedOut: true } : {}),
        })
      })
    },
  )

  if (isAsync && asyncRecord) {
    claudeSyncPromise.catch(() => {})
    return {
      accepted: true,
      taskId: asyncRecord.taskId,
      title: resolvedTitle,
      provider,
      status: 'running',
      note: 'Task started asynchronously. The result will arrive as a follow-up event when the subprocess completes.',
    } satisfies AsyncPlaceholderResult
  }

  return claudeSyncPromise
}
