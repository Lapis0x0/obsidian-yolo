import type { ModuleDataEnvelope } from '../../core/modules/moduleSettingsStore'
import { assertModuleId } from '../../core/modules/moduleStore'
import {
  getYoloJsonDbRootDir,
  getYoloUserDataRootDir,
} from '../../core/paths/yoloPaths'

export type VaultImportFile = Readonly<{
  webkitRelativePath: string
  text(): Promise<string>
}>

const ROOT_DATA_JSON =
  /^([^/]+)\/\.obsidian\/plugins\/(yolo|obsidian-yolo)\/data\.json$/

export function findRootVaultDataJson(
  files: readonly VaultImportFile[],
): VaultImportFile | null {
  return (
    files.find((file) =>
      /^([^/]+)\/\.obsidian\/plugins\/yolo\/data\.json$/.test(
        file.webkitRelativePath,
      ),
    ) ??
    files.find((file) => ROOT_DATA_JSON.test(file.webkitRelativePath)) ??
    null
  )
}

export function isModuleConfigTransferData(value: unknown): boolean {
  if (!isPlainRecord(value)) return false
  return Object.entries(value).every(([moduleId, envelope]) => {
    try {
      assertModuleId(moduleId, 'Module config id')
    } catch {
      return false
    }
    if (!isPlainRecord(envelope)) return false
    const keys = Object.keys(envelope)
    return (
      keys.length === 2 &&
      keys.includes('schemaVersion') &&
      keys.includes('data') &&
      Number.isSafeInteger(envelope.schemaVersion) &&
      (envelope.schemaVersion as number) >= 0
    )
  })
}

export async function collectVaultModuleConfigs(
  files: readonly VaultImportFile[],
  dataJsonPath: string,
  migratedSettings: { yolo?: { baseDir?: string } },
): Promise<Record<string, ModuleDataEnvelope>> {
  const match = ROOT_DATA_JSON.exec(dataJsonPath)
  if (!match) throw new Error('Selected plugin data.json is not at vault root')
  // Accept both the current visible root (`data/module-settings/`) and the
  // legacy hidden root (`.yolo_json_db/module-settings/`) — an imported
  // folder may be a backup taken with an older plugin version that predates
  // this migration.
  const prefixes = [
    `${match[1]}/${getYoloUserDataRootDir(migratedSettings)}/module-settings/`,
    `${match[1]}/${getYoloJsonDbRootDir(migratedSettings)}/module-settings/`,
  ]
  const configs: Record<string, ModuleDataEnvelope> = {}
  for (const file of files) {
    const prefix = prefixes.find((candidate) =>
      file.webkitRelativePath.startsWith(candidate),
    )
    if (!prefix) continue
    const name = file.webkitRelativePath.slice(prefix.length)
    if (!name.endsWith('.json')) continue
    const moduleId = name.slice(0, -'.json'.length)
    if (!moduleId || moduleId.includes('/')) continue
    let envelope: unknown
    try {
      envelope = JSON.parse(await file.text())
    } catch {
      throw new Error(
        `Module config file is invalid JSON: ${file.webkitRelativePath}`,
      )
    }
    if (!isModuleConfigTransferData({ [moduleId]: envelope })) {
      throw new Error(
        `Module config file is invalid: ${file.webkitRelativePath}`,
      )
    }
    configs[moduleId] = envelope as ModuleDataEnvelope
  }
  return configs
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
