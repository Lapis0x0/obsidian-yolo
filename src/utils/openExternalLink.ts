import { Platform } from 'obsidian'

/**
 * 在用户的系统默认浏览器打开 URL,绕过 Obsidian「Web viewer」核心插件或
 * 第三方浏览器插件(如 Surfing)对 window.open 的全局劫持。
 *
 * 桌面端通过 Electron `shell.openExternal` 直接交给 OS;移动端无 Electron,
 * 回退到 `window.open`(Obsidian 自身会路由到系统浏览器)。
 */
export function openExternalLink(url: string): void {
  if (Platform.isDesktopApp) {
    try {
      // electron 是 Obsidian 桌面运行时注入的全局 require,
      // esbuild.config.mjs 已将其配置为 external,不会进入移动端 bundle。
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- desktop-only runtime API injected by Obsidian
      const { shell } = require('electron') as {
        shell: { openExternal: (url: string) => Promise<void> }
      }
      void shell.openExternal(url)
      return
    } catch {
      // Electron 不可用时回退;桌面端理论上不会走到这里
    }
  }
  window.open(url, '_blank')
}
