import { App, normalizePath } from 'obsidian'
import { z } from 'zod'

import {
  type YoloSettingsLike,
  ensureJsonDbRootDir,
} from '../paths/yoloManagedData'

import type { CliModelCatalogStore } from './model-catalog'
import { CLI_RUNTIME_IDS } from './types'
import type { CliRuntimeId, CliRuntimeModel } from './types'

const FILE_NAME = 'cli_model_catalog.json'
const modelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  reasoningEfforts: z.array(
    z.object({ id: z.string(), description: z.string().optional() }),
  ),
  defaultReasoningEffort: z.string().optional(),
  isDefault: z.boolean().optional(),
})
const documentSchema = z.object({
  schemaVersion: z.literal(1),
  providers: z.object({
    'claude-code': z.array(modelSchema).optional(),
    codex: z.array(modelSchema).optional(),
    hermes: z.array(modelSchema).optional(),
    pi: z.array(modelSchema).optional(),
  }),
})

export class VaultCliModelCatalogStore implements CliModelCatalogStore {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly app: App,
    private readonly getSettings: () => YoloSettingsLike | null,
  ) {}

  async read(): Promise<Map<CliRuntimeId, readonly CliRuntimeModel[]>> {
    const path = await this.path()
    if (!(await this.app.vault.adapter.exists(path))) return new Map()
    const document = documentSchema.parse(
      JSON.parse(await this.app.vault.adapter.read(path)),
    )
    return new Map(
      CLI_RUNTIME_IDS.flatMap((runtimeId) => {
        const models = document.providers[runtimeId]
        return models ? [[runtimeId, models] as const] : []
      }),
    )
  }

  write(
    models: ReadonlyMap<CliRuntimeId, readonly CliRuntimeModel[]>,
  ): Promise<void> {
    const task = this.writeTail.then(async () => {
      const providers = Object.fromEntries(models)
      const content = documentSchema.parse({ schemaVersion: 1, providers })
      await this.app.vault.adapter.write(
        await this.path(),
        `${JSON.stringify(content, null, 2)}\n`,
      )
    })
    this.writeTail = task.catch(() => undefined)
    return task
  }

  private async path(): Promise<string> {
    const root = await ensureJsonDbRootDir(this.app, this.getSettings())
    return normalizePath(`${root}/${FILE_NAME}`)
  }
}
