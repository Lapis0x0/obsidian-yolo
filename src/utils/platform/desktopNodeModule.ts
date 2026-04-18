type NodeModuleLoader = (specifier: string) => unknown

const getDesktopRequire = (): NodeModuleLoader => {
  const globalRequire = (
    globalThis as typeof globalThis & { require?: NodeModuleLoader }
  ).require
  if (typeof globalRequire === 'function') {
    return globalRequire
  }

  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- indirect require lookup for Obsidian desktop runtime
  const indirectRequire = Function(
    'return typeof require === "function" ? require : undefined',
  )() as NodeModuleLoader | undefined
  if (typeof indirectRequire === 'function') {
    return indirectRequire
  }

  throw new Error('Node.js modules are unavailable in this Obsidian runtime.')
}

export const loadDesktopNodeModule = async <T>(specifier: string): Promise<T> =>
  getDesktopRequire()(specifier) as T
