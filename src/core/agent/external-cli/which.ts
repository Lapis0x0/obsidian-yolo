// 跨平台 which 实现，处理 Windows PATHEXT
//
// 关于 node 模块的 import 策略：
// 此模块仅被 runner.ts 静态 import；而 runner.ts 整体由 external-cli/index.ts
// 在 Platform.isDesktop 守卫后通过 `await import('./runner')` 懒加载。所以本文件
// 不会在 mobile 求值，可安全顶级静态 import node 内置模块——esbuild 已将 node:*
// 标记为 external，cjs 输出会转换为 `require()`，可被 Electron renderer 正确解析。
// 反之 dynamic `await import('node:...')` 在 cjs 下会保留为 ES dynamic import，
// 浏览器引擎会把 node: 前缀当 URL fetch 而失败。
/* eslint-disable import/no-nodejs-modules -- desktop-only module, lazy-loaded behind Platform.isDesktop */
import { access, constants } from 'node:fs/promises'
import * as path from 'node:path'
/* eslint-enable import/no-nodejs-modules */

/**
 * 取多个候选值中第一个非空字符串。
 * `??` 不会跳过 ''，但 Windows env 在跨工具合并/规范化时可能出现某个变体为空串、
 * 另一个有值的情况（如 process.env 兼容层、childProcess 父子环境合并）。
 */
function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const v of values) {
    if (v !== undefined && v !== '') return v
  }
  return undefined
}

/**
 * 在 PATH 中查找可执行文件的完整路径。
 * macOS/Linux：直接按 PATH 顺序搜索。
 * Windows：对每个路径条目依次附加 PATHEXT 扩展名尝试。
 *
 * @returns 找到的绝对路径，找不到时返回 null
 */
export async function which(
  name: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  // Windows 环境变量名大小写不敏感（PATH 实际可能叫 Path 或 path），
  // 而 shell-env 在 Windows 上直接返回 process.env，不做规范化。
  // 同理 PATHEXT 也兼容大小写。
  const envPath = firstNonEmpty(env.PATH, env.Path, env.path) ?? ''
  const pathDirs = envPath.split(path.delimiter).filter(Boolean)

  const isWindows = process.platform === 'win32'
  // Windows 下从环境变量取扩展名列表，默认兜底
  const pathext = isWindows
    ? (
        firstNonEmpty(env.PATHEXT, env.Pathext, env.pathext) ??
        '.COM;.EXE;.BAT;.CMD'
      )
        .split(';')
        .filter(Boolean)
    : ['']

  for (const dir of pathDirs) {
    for (const ext of pathext) {
      const candidate = path.join(dir, name + ext)
      try {
        await access(candidate, constants.X_OK)
        return candidate
      } catch {
        // 继续尝试下一个
      }
    }
  }

  return null
}
