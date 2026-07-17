import cx from 'clsx'
import { Sparkles, X } from 'lucide-react'
import { TFile } from 'obsidian'
import type React from 'react'
import { useState } from 'react'

import {
  type StagedReference,
  cleanupStaging,
  createStagingDir,
  validateReferenceFile,
  writeReferenceToStaging,
} from '../../core/learning/generation/referenceStaging'

import { LearningFileDropzone, LearningModal } from './LearningModal'
import { useLearningLanguage, useLearningUiHost } from './LearningUiHost'

const levelIds = ['beginner', 'familiar', 'experienced', 'advanced'] as const

export type LearningWizardInput = {
  topic: string
  level: string
  goal: string
  referenceFiles?: StagedReference[]
  stagingDir?: string
}

export function Wizard({
  learningBaseDir,
  onClose,
  onComplete,
}: {
  learningBaseDir: string
  onClose: () => void
  onComplete: (input: LearningWizardInput) => void
}) {
  const app = useLearningUiHost().app
  const { t } = useLearningLanguage()
  const levels = levelIds.map((id) => ({
    value: id,
    label: t(`learning.wizard.levels.${id}`, id),
  }))
  const [topic, setTopic] = useState('')
  const [goal, setGoal] = useState('')
  const [level, setLevel] = useState<(typeof levelIds)[number]>('familiar')
  const [referenceFiles, setReferenceFiles] = useState<StagedReference[]>([])
  const [stagingDir, setStagingDir] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const closeAndCleanup = () => {
    if (stagingDir) void cleanupStaging(app, stagingDir)
    onClose()
  }

  const handleFiles = async (files: FileList | File[]) => {
    setUploadError(null)
    const fileArray = Array.from(files)
    if (fileArray.length === 0) return

    let dir = stagingDir
    if (!dir) {
      dir = await createStagingDir(app, learningBaseDir, crypto.randomUUID())
      setStagingDir(dir)
    }

    const newRefs: StagedReference[] = []
    for (const file of fileArray) {
      const error = validateReferenceFile(file)
      if (error) {
        setUploadError(error)
        continue
      }
      const ref = await writeReferenceToStaging(
        app,
        dir,
        file.name,
        await file.arrayBuffer(),
      )
      newRefs.push(ref)
    }
    const newPaths = new Set(newRefs.map((ref) => ref.vaultPath))
    setReferenceFiles((prev) => [
      ...prev.filter((ref) => !newPaths.has(ref.vaultPath)),
      ...newRefs,
    ])
  }

  const removeReference = async (ref: StagedReference) => {
    const file = app.vault.getAbstractFileByPath(ref.vaultPath)
    if (file instanceof TFile) await app.fileManager.trashFile(file)
    setReferenceFiles((prev) =>
      prev.filter((item) => item.vaultPath !== ref.vaultPath),
    )
  }

  return (
    <LearningModal
      title={t('learning.wizard.title', '新建学习项目')}
      onClose={closeAndCleanup}
      closeLabel={t('common.close', '关闭')}
      footer={
        <>
          <button
            type="button"
            onClick={closeAndCleanup}
            className="yolo-learning-wizard-cancel"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            onClick={() =>
              onComplete({
                topic,
                level,
                goal,
                referenceFiles,
                stagingDir: stagingDir ?? undefined,
              })
            }
            className="yolo-learning-wizard-primary"
          >
            <Sparkles size={16} />
            {t('learning.wizard.createOutline', '创建并生成大纲')}
          </button>
        </>
      }
    >
      <StepOne
        topic={topic}
        setTopic={setTopic}
        goal={goal}
        setGoal={setGoal}
        level={level}
        setLevel={setLevel}
        levels={levels}
        referenceFiles={referenceFiles}
        uploadError={uploadError}
        handleFiles={handleFiles}
        removeReference={removeReference}
        t={t}
      />
    </LearningModal>
  )
}

function StepOne({
  topic,
  setTopic,
  goal,
  setGoal,
  level,
  setLevel,
  levels,
  referenceFiles,
  uploadError,
  handleFiles,
  removeReference,
  t,
}: {
  topic: string
  setTopic: (value: string) => void
  goal: string
  setGoal: (value: string) => void
  level: (typeof levelIds)[number]
  setLevel: (value: (typeof levelIds)[number]) => void
  levels: { value: (typeof levelIds)[number]; label: string }[]
  referenceFiles: StagedReference[]
  uploadError: string | null
  handleFiles: (files: FileList | File[]) => Promise<void>
  removeReference: (ref: StagedReference) => Promise<void>
  t: (keyPath: string, fallback?: string) => string
}) {
  return (
    <div className="yolo-learning-wizard-step">
      <div className="yolo-learning-wizard-intro">
        <div className="yolo-learning-wizard-intro-icon">
          <Sparkles size={22} />
        </div>
        <div>
          <h2 className="yolo-learning-wizard-heading">
            {t('learning.wizard.heading', '告诉 YOLO 你想学什么')}
          </h2>
          <p className="yolo-learning-wizard-description">
            {t(
              'learning.wizard.description',
              '填写下面的信息，YOLO 会为你生成一份结构化的学习大纲。',
            )}
          </p>
        </div>
      </div>

      <Field
        label={t('learning.wizard.topicLabel', '学习主题')}
        hint={t(
          'learning.wizard.topicHint',
          '例如：学习 React、刑法总则、读懂一篇论文',
        )}
      >
        <input
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          placeholder={t('learning.wizard.topicPlaceholder', '学习 React')}
          className="yolo-learning-wizard-input"
        />
      </Field>

      <Field label={t('learning.wizard.modeLabel', '学习模式')}>
        <div className="yolo-learning-wizard-mode-grid">
          <div
            className={cx(
              'yolo-learning-wizard-mode-card',
              'yolo-learning-wizard-mode-card-selected',
            )}
          >
            <div className="yolo-learning-wizard-mode-title">
              {t('learning.wizard.modes.standard.title', '标准模式')}
            </div>
            <div className="yolo-learning-wizard-mode-description">
              {t(
                'learning.wizard.modes.standard.desc',
                '生成结构化知识体系，含知识点、卡片和习题',
              )}
            </div>
          </div>
          <div
            className="yolo-learning-wizard-mode-card yolo-learning-wizard-mode-card-disabled"
            aria-disabled
          >
            <div className="yolo-learning-wizard-mode-title">
              {t('learning.wizard.modes.project.title', '项目制模式')}
            </div>
            <div className="yolo-learning-wizard-mode-description">
              {t(
                'learning.wizard.modes.project.desc',
                '以动手项目驱动，AI 引导你逐步完成交付',
              )}
            </div>
            <span className="yolo-learning-wizard-mode-badge">
              {t('learning.wizard.modes.comingSoon', '即将推出')}
            </span>
          </div>
        </div>
      </Field>

      <Field label={t('learning.wizard.levelLabel', '当前水平')}>
        <ChipGroup options={levels} value={level} onChange={setLevel} />
      </Field>

      <Field
        label={t('learning.wizard.goalLabel', '学习目标与补充要求')}
        hint={t(
          'learning.wizard.goalHint',
          '你希望达到什么程度？也可以补充时间安排、应用场景或不想学习的内容。',
        )}
      >
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          placeholder={t(
            'learning.wizard.goalPlaceholder',
            '能够独立开发中等复杂度的 React 应用；两周内完成，偏实战，少讲纯理论',
          )}
          className="yolo-learning-wizard-textarea"
        />
      </Field>

      <Field
        label={t('learning.wizard.referencesLabel', '参考资料')}
        optional
        hint={t('learning.wizard.referencesHint', '上传后 YOLO 会据此定制大纲')}
        optionalLabel={t('learning.wizard.optional', '（可选）')}
      >
        <LearningFileDropzone
          accept=".pdf,.docx,.doc,.md,.markdown,.txt"
          multiple
          title={t('learning.wizard.uploadTitle', '拖拽文件到此处，或点击上传')}
          hint={t(
            'learning.wizard.uploadHint',
            '支持 PDF、Word、Markdown，单个文件 ≤ 20MB',
          )}
          onFiles={handleFiles}
        />
        {uploadError && (
          <div className="yolo-learning-wizard-upload-error">{uploadError}</div>
        )}
        {referenceFiles.length > 0 && (
          <div className="yolo-learning-wizard-upload-list">
            {referenceFiles.map((ref) => (
              <div
                key={ref.vaultPath}
                className="yolo-learning-wizard-upload-item"
              >
                <span className="yolo-learning-wizard-upload-item-name">
                  {ref.name}
                </span>
                <button
                  type="button"
                  onClick={() => void removeReference(ref)}
                  className="yolo-learning-wizard-upload-item-remove"
                  aria-label={t('common.remove', '移除')}
                >
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Field>
    </div>
  )
}

function Field({
  label,
  required,
  optional,
  optionalLabel = '（可选）',
  hint,
  children,
}: {
  label: string
  required?: boolean
  optional?: boolean
  optionalLabel?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="yolo-learning-wizard-field">
      <div className="yolo-learning-wizard-field-header">
        <label className="yolo-learning-wizard-label">
          {label}
          {required && <span className="yolo-learning-wizard-required">*</span>}
          {optional && (
            <span className="yolo-learning-wizard-optional">
              {optionalLabel}
            </span>
          )}
        </label>
        {hint && <span className="yolo-learning-wizard-hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

function ChipGroup({
  options,
  value,
  onChange,
}: {
  options: { value: (typeof levelIds)[number]; label: string }[]
  value: (typeof levelIds)[number]
  onChange: (value: (typeof levelIds)[number]) => void
}) {
  return (
    <div className="yolo-learning-wizard-chip-group">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cx(
            'yolo-learning-wizard-chip',
            value === option.value && 'yolo-learning-wizard-chip-selected',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
