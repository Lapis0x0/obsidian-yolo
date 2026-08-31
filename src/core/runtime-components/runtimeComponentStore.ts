import { type DataAdapter, normalizePath } from 'obsidian'

import { resolveModulePluginDir } from '../modules/moduleStore'

import type {
  RuntimeComponentAssetDescriptor,
  RuntimeComponentDescriptor,
} from './runtimeComponentManifest'

export class RuntimeComponentStore {
  readonly pluginDir: string

  constructor(
    readonly adapter: DataAdapter,
    manifest: Readonly<{ id: string; dir?: string }>,
    configDir: string,
  ) {
    this.pluginDir = resolveModulePluginDir(manifest, configDir)
  }

  rootPath(): string {
    return normalizePath(`${this.pluginDir}/runtime/components`)
  }

  componentRoot(descriptor: RuntimeComponentDescriptor): string {
    return normalizePath(`${this.rootPath()}/${descriptor.id}`)
  }

  targetDir(descriptor: RuntimeComponentDescriptor): string {
    return normalizePath(
      `${this.componentRoot(descriptor)}/${descriptor.sha256}`,
    )
  }

  entryPath(descriptor: RuntimeComponentDescriptor): string {
    return normalizePath(`${this.targetDir(descriptor)}/entry.js`)
  }

  assetsDir(descriptor: RuntimeComponentDescriptor): string {
    return normalizePath(`${this.targetDir(descriptor)}/assets`)
  }

  assetPath(
    descriptor: RuntimeComponentDescriptor,
    asset: RuntimeComponentAssetDescriptor,
  ): string {
    return normalizePath(`${this.assetsDir(descriptor)}/${asset.name}`)
  }

  async readEntry(descriptor: RuntimeComponentDescriptor): Promise<Uint8Array> {
    const value = await this.adapter.readBinary(this.entryPath(descriptor))
    return new Uint8Array(value)
  }

  async readAsset(
    descriptor: RuntimeComponentDescriptor,
    asset: RuntimeComponentAssetDescriptor,
  ): Promise<Uint8Array> {
    const value = await this.adapter.readBinary(
      this.assetPath(descriptor, asset),
    )
    return new Uint8Array(value)
  }

  async hasPlausibleEntry(
    descriptor: RuntimeComponentDescriptor,
  ): Promise<boolean> {
    const stat = await this.adapter.stat(this.entryPath(descriptor))
    if (stat?.type !== 'file' || stat.size !== descriptor.byteSize) {
      return false
    }
    for (const asset of descriptor.assets ?? []) {
      const assetStat = await this.adapter.stat(
        this.assetPath(descriptor, asset),
      )
      if (assetStat?.type !== 'file' || assetStat.size !== asset.byteSize) {
        return false
      }
    }
    return true
  }
}
