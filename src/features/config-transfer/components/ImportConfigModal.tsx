import { App, Notice, Platform } from 'obsidian'
import React, { useCallback, useMemo, useState } from 'react'

import { ReactModal } from '../../../components/common/ReactModal'
import { useLanguage } from '../../../contexts/language-context'
import type { ModuleDataEnvelope } from '../../../core/modules/moduleSettingsStore'
import { writeObsidianModuleConfigEnvelopes } from '../../../core/modules/obsidianModuleConfigBackend'
import { MODULE_CONFIG_TRANSFER_KEY } from '../../../core/persistence/persistentDataRegistry'
import YoloPlugin from '../../../main'
import { migrateYoloSettingsData } from '../../../settings/schema/settings'
import { EXCLUDED_KEYS, EXPORTABLE_CONFIG_KEYS } from '../config-keys'
import {
  ImportValidationError,
  ModuleConfigImportPartialError,
  applyImport,
  parseVaultData,
  renderImportError,
  validateExportFile,
} from '../import-config'
import { hasNonEmptyCredentials } from '../redact'
import {
  ConfigExportFile,
  MODULE_CONFIG_EXPORT_FORMAT_VERSION,
  MODULE_CONFIG_EXPORT_SCHEMA,
  MergeStrategy,
} from '../types'
import {
  collectVaultModuleConfigs,
  findRootVaultDataJson,
} from '../vault-module-configs'

type ImportConfigModalComponentProps = {
  plugin: YoloPlugin
}

export class ImportConfigModal extends ReactModal<ImportConfigModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: ImportConfigModalComponent,
      props: { plugin },
      options: {
        title: plugin.t('configTransfer.import.title', '导入配置'),
      },
      plugin,
    })
  }
}

type ImportStep = 'source' | 'select'

function ImportConfigModalComponent({
  plugin,
  onClose,
}: ImportConfigModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [step, setStep] = useState<ImportStep>('source')
  const [importData, setImportData] = useState<ConfigExportFile | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [mergeStrategy, setMergeStrategy] = useState<MergeStrategy>('overwrite')

  const handleFileImport = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      try {
        const text = await file.text()
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          new Notice(
            t(
              'configTransfer.import.noticeInvalidJson',
              '文件不是有效的 JSON 格式，请确认选择了正确的配置文件。',
            ),
            5000,
          )
          return
        }
        const result = await validateExportFile(raw)
        if (!result.valid) {
          new Notice(renderImportError(result, t), 5000)
          return
        }
        setImportData(result.data)
        setSelectedKeys(new Set(result.data.keys))
        setStep('select')
        if (result.data.redacted) {
          new Notice(
            t(
              'configTransfer.import.noticeRedactedHint',
              '注意：该配置为脱敏导出，所有 API Key / 密码 / Header / 环境变量已被清空，需导入后手动补填。',
            ),
            5000,
          )
        }
      } catch {
        new Notice(
          t(
            'configTransfer.import.noticeFileReadFailed',
            '文件读取失败，请重试。',
          ),
          5000,
        )
      }
    }
    input.click()
  }, [t])

  const handleVaultImport = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files
      if (!files || files.length === 0) return

      const selectedFiles = Array.from(files)
      const dataJsonFile = findRootVaultDataJson(selectedFiles)

      if (!dataJsonFile) {
        new Notice(
          t(
            'configTransfer.import.noticePluginNotFound',
            '未在该目录找到 YOLO 插件配置',
          ),
          5000,
        )
        return
      }

      try {
        const text = await dataJsonFile.text()
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          new Notice(
            t(
              'configTransfer.import.noticeInvalidJson',
              '配置文件不是有效的 JSON 格式',
            ),
            5000,
          )
          return
        }
        const parsed = parseVaultData(raw, plugin.manifest.version)
        if (!parsed.valid) {
          new Notice(renderImportError(parsed, t), 5000)
          return
        }
        const migrated = migrateYoloSettingsData(raw as Record<string, unknown>)
        let moduleConfigs: Record<string, ModuleDataEnvelope>
        try {
          moduleConfigs = await collectVaultModuleConfigs(
            selectedFiles,
            dataJsonFile.webkitRelativePath,
            migrated,
          )
        } catch (error) {
          throw new ImportValidationError(
            'errorTampered',
            error instanceof Error ? error.message : String(error),
          )
        }
        const result: { valid: true; data: ConfigExportFile } =
          Object.keys(moduleConfigs).length === 0
            ? parsed
            : {
                valid: true as const,
                data: {
                  ...parsed.data,
                  $schema: MODULE_CONFIG_EXPORT_SCHEMA,
                  formatVersion: MODULE_CONFIG_EXPORT_FORMAT_VERSION,
                  keys: [...parsed.data.keys, MODULE_CONFIG_TRANSFER_KEY],
                  data: {
                    ...parsed.data.data,
                    [MODULE_CONFIG_TRANSFER_KEY]: moduleConfigs,
                  },
                  checksum: '',
                },
              }
        setImportData(result.data)
        setSelectedKeys(
          new Set(result.data.keys.filter((k) => !EXCLUDED_KEYS.has(k))),
        )
        setStep('select')
      } catch (error) {
        if (error instanceof ImportValidationError) {
          new Notice(renderImportError(error, t), 8000)
        } else {
          new Notice(
            t('configTransfer.import.noticeFileReadFailed', '配置文件读取失败'),
            5000,
          )
        }
      }
    }
    input.click()
  }, [plugin, t])

  const toggleKey = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const selectAll = () => {
    if (importData) {
      setSelectedKeys(
        new Set(importData.keys.filter((k) => !EXCLUDED_KEYS.has(k))),
      )
    }
  }

  const selectNone = () => {
    setSelectedKeys(new Set())
  }

  const handleImport = async () => {
    if (!importData) return
    if (selectedKeys.size === 0) {
      new Notice(
        t('configTransfer.import.noticeAtLeastOne', '请至少选择一项配置'),
      )
      return
    }

    try {
      const currentSettings = plugin.settings
      const result = applyImport({
        importData,
        selectedKeys: Array.from(selectedKeys),
        currentSettings,
        mergeStrategy,
      })

      const saved = await plugin.setSettings(result)
      if (!saved) return

      if (selectedKeys.has(MODULE_CONFIG_TRANSFER_KEY)) {
        const moduleConfigs = importData.data[MODULE_CONFIG_TRANSFER_KEY]
        if (
          moduleConfigs === null ||
          typeof moduleConfigs !== 'object' ||
          Array.isArray(moduleConfigs)
        ) {
          throw new Error('模块配置文件格式无效')
        }
        // Host settings are committed first so this resolves the final
        // baseDir. Module writes are individually verified, but cannot be
        // atomic with data.json; a later failure is surfaced as partial import.
        try {
          await writeObsidianModuleConfigEnvelopes(
            plugin.app,
            plugin.settings,
            moduleConfigs as Record<string, ModuleDataEnvelope>,
          )
        } catch (error) {
          throw new ModuleConfigImportPartialError(error)
        }
      }
      new Notice(t('configTransfer.import.noticeSuccess', '配置导入成功'))

      if (importData.redacted) {
        new Notice(
          t(
            'configTransfer.import.noticeRedactedReminder',
            '注意：该配置为脱敏导出，所有 API Key / 密码 / Header / 环境变量已被清空，请前往设置补填。',
          ),
          5000,
        )
      }

      onClose()
    } catch (err) {
      console.error('Failed to import config', err)
      const failedPrefix = t(
        'configTransfer.import.noticeFailed',
        '配置导入失败',
      )
      if (err instanceof ModuleConfigImportPartialError) {
        new Notice(
          t(
            'configTransfer.import.noticePartialModuleConfig',
            'Host 配置已导入，但模块配置导入失败；部分模块配置可能已写入，未自动回滚。',
          ),
          8000,
        )
        return
      }
      if (err instanceof ImportValidationError) {
        const reason = renderImportError(err, t)
        const detail =
          err.issues.length > 0 ? `\n${err.issues.slice(0, 5).join('\n')}` : ''
        new Notice(`${failedPrefix}：${reason}${detail}`, 8000)
      } else {
        const message = err instanceof Error ? err.message : String(err)
        new Notice(`${failedPrefix}：${message}`, 8000)
      }
    }
  }

  const availableKeys = importData
    ? EXPORTABLE_CONFIG_KEYS.filter((k) => importData.keys.includes(k.key))
    : []

  // 基于待导入数据的实际内容判定哪些 key 含凭证。脱敏导出（redacted=true）
  // 时所有敏感字段都是随机字符串，仍判定为"含凭证"——因为提示用户"这部分
  // 涉及凭证、会被清空"是正确的语义。
  const credentialsByKey = useMemo(() => {
    const map: Record<string, boolean> = {}
    if (!importData) return map
    for (const item of availableKeys) {
      map[item.key] = hasNonEmptyCredentials(importData.data[item.key])
    }
    return map
  }, [importData, availableKeys])

  if (step === 'source') {
    return (
      <div className="yolo-config-transfer-modal">
        <div className="yolo-config-transfer-source-buttons">
          <button
            className="yolo-config-transfer-source-btn"
            onClick={handleFileImport}
          >
            <strong>
              {t('configTransfer.import.sourceFile', '从配置文件导入')}
            </strong>
            <span>
              {t(
                'configTransfer.import.sourceFileDesc',
                '选择之前导出的 .json 文件',
              )}
            </span>
          </button>

          {Platform.isDesktop && (
            <button
              className="yolo-config-transfer-source-btn"
              onClick={handleVaultImport}
            >
              <strong>
                {t('configTransfer.import.sourceVault', '从其他笔记库导入')}
              </strong>
              <span>
                {t(
                  'configTransfer.import.sourceVaultDesc',
                  '选择已安装 YOLO 的笔记库目录',
                )}
              </span>
            </button>
          )}
        </div>

        <div className="modal-button-container">
          <button className="mod-cancel" onClick={onClose}>
            {t('configTransfer.import.cancel', '取消')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="yolo-config-transfer-modal">
      <div className="yolo-config-transfer-toolbar">
        <div className="yolo-config-transfer-desc">
          {t('configTransfer.import.description', '选择要导入的配置项')}
        </div>
        <div className="yolo-config-transfer-toolbar-actions">
          <button onClick={selectAll}>
            {t('configTransfer.import.selectAll', '全选')}
          </button>
          <button onClick={selectNone}>
            {t('configTransfer.import.selectNone', '全不选')}
          </button>
        </div>
      </div>

      <div className="yolo-config-transfer-list">
        {availableKeys.map((item) => (
          <label key={item.key} className="yolo-config-transfer-item">
            <input
              type="checkbox"
              checked={selectedKeys.has(item.key)}
              onChange={() => toggleKey(item.key)}
            />
            <span className="yolo-config-transfer-item-label">
              {t(`configTransfer.keyLabels.${item.key}`, item.fallbackLabel)}
              <span className="yolo-config-transfer-item-key">{item.key}</span>
            </span>
            {credentialsByKey[item.key] && (
              <span className="yolo-config-transfer-sensitive">
                {t('configTransfer.import.sensitive', '含凭证')}
              </span>
            )}
          </label>
        ))}
      </div>

      <div className="yolo-config-transfer-strategy">
        <label
          className={`yolo-config-transfer-strategy-option${mergeStrategy === 'overwrite' ? ' is-selected' : ''}`}
          onClick={() => setMergeStrategy('overwrite')}
        >
          <span className="yolo-config-transfer-radio">
            {mergeStrategy === 'overwrite' && (
              <span className="yolo-config-transfer-radio-dot" />
            )}
          </span>
          <span>
            <strong>
              {t('configTransfer.import.strategyOverwriteTitle', '全量覆盖')}
            </strong>
            {' — '}
            {t(
              'configTransfer.import.strategyOverwriteDesc',
              '用导入的配置替换选中项',
            )}
          </span>
        </label>
        <label
          className={`yolo-config-transfer-strategy-option${mergeStrategy === 'merge' ? ' is-selected' : ''}`}
          onClick={() => setMergeStrategy('merge')}
        >
          <span className="yolo-config-transfer-radio">
            {mergeStrategy === 'merge' && (
              <span className="yolo-config-transfer-radio-dot" />
            )}
          </span>
          <span>
            <strong>
              {t('configTransfer.import.strategyMergeTitle', 'JSON 合并')}
            </strong>
            {' — '}
            {t(
              'configTransfer.import.strategyMergeDesc',
              '深度合并，保留未冲突的现有值',
            )}
          </span>
        </label>
      </div>

      <div className="modal-button-container">
        <button className="mod-cta" onClick={() => void handleImport()}>
          {t('configTransfer.import.submit', '确认导入')}
        </button>
        <button className="mod-cancel" onClick={() => setStep('source')}>
          {t('configTransfer.import.back', '返回')}
        </button>
        <button className="mod-cancel" onClick={onClose}>
          {t('configTransfer.import.cancel', '取消')}
        </button>
      </div>
    </div>
  )
}
