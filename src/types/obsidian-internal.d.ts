import 'obsidian'

declare module 'obsidian' {
  interface App {
    internalPlugins?: {
      getPluginById?: (id: string) => InternalPluginInstance | null
      plugins?: Record<string, InternalPluginInstance | undefined>
    }
  }
}

type InternalPluginInstance = {
  enabled?: boolean
  _loaded?: boolean
  instance?: {
    options?: Record<string, unknown>
  }
}
