import 'obsidian'

declare module 'obsidian' {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- module augmentation requires interface
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
