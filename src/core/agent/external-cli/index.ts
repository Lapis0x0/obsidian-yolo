// 外部 CLI 公开入口
// Platform.isDesktop 守卫 + 懒加载 runner（保持 mobile 安全）
import { Platform } from 'obsidian'

import type {
  AsyncPlaceholderResult,
  RunExternalAgentParams,
  RunExternalAgentResult,
} from './runner'

export type {
  AsyncPlaceholderResult,
  ExternalAgentProvider,
  RunExternalAgentParams,
  RunExternalAgentResult,
} from './runner'
export { externalCliStreamBus } from './streamBus'
export type {
  ExternalCliEvent,
  ExternalCliSnapshot,
  ExternalCliStatus,
} from './streamBus'

/**
 * 在本机运行外部 CLI Agent。
 * 仅桌面端可用；在移动端调用时直接抛出错误。
 */
export async function runExternalAgent(
  params: RunExternalAgentParams,
): Promise<RunExternalAgentResult | AsyncPlaceholderResult> {
  if (!Platform.isDesktop) {
    throw new Error('External agent delegation is only available on desktop.')
  }
  // 懒加载，避免 node:child_process 等在 mobile/web 环境被求值
  const { runExternalAgent: _run } = await import('./runner')
  return _run(params)
}

/**
 * plugin unload 时调用，终止所有活跃子进程。
 * 仅桌面端执行，mobile 为空操作。
 */
export async function killAllActiveExternalCli(): Promise<void> {
  if (!Platform.isDesktop) return
  const { killAllActiveExternalCli: _kill } = await import('./runner')
  _kill()
}
