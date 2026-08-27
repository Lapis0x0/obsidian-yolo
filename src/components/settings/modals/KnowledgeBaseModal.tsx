import { App, Notice } from 'obsidian'
import { useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  SettingsProvider,
  useSettings,
} from '../../../contexts/settings-context'
import type YoloPlugin from '../../../main'
import { KnowledgeBase } from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'
import {
  type ScopeRule,
  rulesFromWorkspaceScope,
  workspaceScopeFromRules,
} from '../scope/scopeRules'
import { ScopeSummary } from '../scope/ScopeSummary'
import { collectScopeCandidateFiles } from '../scope/scopeVault'

type KnowledgeBaseModalComponentProps = {
  app: App
  plugin: YoloPlugin
  /** Absent = creating a new knowledge base. */
  kbId?: string
}

export class KnowledgeBaseModal extends ReactModal<KnowledgeBaseModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, kbId?: string) {
    super({
      app,
      Component: KnowledgeBaseModalComponentWrapper,
      props: { app, plugin, kbId },
      options: { title: undefined },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function KnowledgeBaseModalComponentWrapper({
  app,
  plugin,
  kbId,
  onClose,
}: KnowledgeBaseModalComponentProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <KnowledgeBaseModalContent
        app={app}
        plugin={plugin}
        kbId={kbId}
        onClose={onClose}
      />
    </SettingsProvider>
  )
}

const isDuplicateName = (
  knowledgeBases: readonly KnowledgeBase[],
  name: string,
  ignoreId: string | undefined,
): boolean => {
  const target = name.trim().toLowerCase()
  return knowledgeBases.some(
    (kb) => kb.id !== ignoreId && kb.name.trim().toLowerCase() === target,
  )
}

function KnowledgeBaseModalContent({
  app,
  plugin,
  kbId,
  onClose,
}: KnowledgeBaseModalComponentProps & { onClose: () => void }) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const existing = settings.knowledgeBases.find((kb) => kb.id === kbId)
  const isCreate = !existing

  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [include, setInclude] = useState<string[]>(existing?.include ?? [])
  const [exclude, setExclude] = useState<string[]>(existing?.exclude ?? [])
  const [nameError, setNameError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const scopeRules = rulesFromWorkspaceScope({ include, exclude })
  const isIndexPdfEnabled = settings.ragOptions.indexPdf ?? true
  const scopeCandidateFiles = collectScopeCandidateFiles(
    plugin.app.vault,
    isIndexPdfEnabled ? ['md', 'pdf'] : ['md'],
    settings,
  )

  const handleScopeChange = (nextRules: ScopeRule[]) => {
    const next = workspaceScopeFromRules(nextRules)
    setInclude(next.include)
    setExclude(next.exclude)
  }

  const handleSave = () => {
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError(
        t('settings.knowledgeBases.nameRequired', '请输入知识库名称'),
      )
      return
    }
    if (isDuplicateName(settings.knowledgeBases, trimmedName, existing?.id)) {
      setNameError(
        t('settings.knowledgeBases.nameDuplicate', '已存在同名知识库'),
      )
      return
    }
    setNameError(null)
    setSaving(true)
    void (async () => {
      try {
        const nextKb: KnowledgeBase = {
          id: existing?.id ?? crypto.randomUUID(),
          name: trimmedName,
          description: description.trim(),
          include,
          exclude,
        }
        const nextKnowledgeBases = existing
          ? settings.knowledgeBases.map((kb) =>
              kb.id === nextKb.id ? nextKb : kb,
            )
          : [...settings.knowledgeBases, nextKb]
        await setSettings({
          ...settings,
          knowledgeBases: nextKnowledgeBases,
        })
        onClose()
      } catch (error) {
        console.error('[YOLO] Failed to save knowledge base:', error)
        new Notice(t('settings.knowledgeBases.saveFailed', '保存知识库失败'))
      } finally {
        setSaving(false)
      }
    })()
  }

  return (
    <div className="yolo-kb-modal">
      <div className="yolo-kb-modal-title">
        {isCreate
          ? t('settings.knowledgeBases.createTitle', '新建知识库')
          : t('settings.knowledgeBases.editTitle', '知识库 · {{name}}').replace(
              '{{name}}',
              existing?.name ?? '',
            )}
      </div>

      <div className="yolo-kb-modal-body">
        <ObsidianSetting
          name={t('settings.knowledgeBases.fieldName', '名称')}
          desc={t('settings.knowledgeBases.fieldNameDesc', '知识库显示名称')}
        >
          <ObsidianTextInput
            value={name}
            onChange={(value) => {
              setName(value)
              if (nameError) setNameError(null)
            }}
          />
        </ObsidianSetting>
        {nameError && (
          <div className="yolo-kb-modal-name-error">{nameError}</div>
        )}

        <ObsidianSetting
          name={t('settings.knowledgeBases.fieldDescription', '描述')}
          desc={t(
            'settings.knowledgeBases.fieldDescriptionDesc',
            '说明这个库主要装了什么。这段会提供给模型，用于判断该检索哪个知识库；可留空。',
          )}
          className="yolo-settings-textarea-header"
        />
        <ObsidianSetting className="yolo-settings-textarea">
          <ObsidianTextArea
            value={description}
            onChange={setDescription}
            autoResize
            maxAutoResizeHeight={160}
            placeholder={t(
              'settings.knowledgeBases.fieldDescriptionPlaceholder',
              '例如：日常会议记录与在做的项目文档',
            )}
          />
        </ObsidianSetting>

        <div className="yolo-kb-modal-scope-section">
          <div className="yolo-kb-modal-scope-title">
            {t('settings.knowledgeBases.scopeTitle', '范围')}
          </div>
          <div className="yolo-kb-modal-scope-desc">
            {t(
              'settings.knowledgeBases.scopeDesc',
              '决定哪些文件夹会进入这个知识库。',
            )}
          </div>
          <ScopeSummary
            app={app}
            vault={plugin.app.vault}
            rules={scopeRules}
            allowFiles={false}
            variant="rag"
            candidateFiles={scopeCandidateFiles}
            defaultRules={[]}
            onChange={handleScopeChange}
          />
        </div>
      </div>

      <div className="yolo-kb-modal-footer">
        <ObsidianButton
          text={t('common.cancel', '取消')}
          onClick={onClose}
          disabled={saving}
        />
        <ObsidianButton
          text={t('common.save', '保存')}
          cta
          onClick={handleSave}
          disabled={saving}
        />
      </div>
    </div>
  )
}
