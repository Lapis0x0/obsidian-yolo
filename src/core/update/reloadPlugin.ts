import type { App } from 'obsidian'

type PluginManager = {
  loadManifest(dir: string): Promise<void>
  disablePlugin(id: string): Promise<void>
  enablePlugin(id: string): Promise<void>
}

/**
 * Loads a plugin again from the files now on disk without reloading the
 * window, the way Obsidian's own community plugin update does. Safe to call
 * from inside the plugin being reloaded: once `disablePlugin` has unloaded
 * it, the chain only calls into Obsidian's plugin manager.
 *
 * `enablePlugin` reads `main.js` from disk but takes the manifest from
 * Obsidian's cache, so the cache is refreshed first. Without that the new
 * instance would start with the old version and install the update again.
 */
export function reloadPlugin(app: App, id: string, dir: string): void {
  // @ts-expect-error: plugins exists on Obsidian's App but is not typed
  const plugins = app.plugins as PluginManager
  void plugins
    .loadManifest(dir)
    .then(() => plugins.disablePlugin(id))
    .then(() => plugins.enablePlugin(id))
    .catch((error: unknown) => {
      console.error(`[YOLO] Reloading plugin "${id}" failed`, error)
    })
}
