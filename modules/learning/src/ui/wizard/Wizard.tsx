import cx from 'clsx'
import { Sparkles, X } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'

import type { StagedReference } from '../../generation/referenceStaging'
import {
  LearningFileDropzone,
  LearningModal,
} from '../primitives/LearningModal'

const levelIds = ['beginner', 'familiar', 'experienced', 'advanced'] as const
type Level = (typeof levelIds)[number]
export type LearningTranslate = (keyPath: string, fallback?: string) => string

export type LearningWizardInput = {
  topic: string
  level: string
  goal: string
  referenceFiles?: StagedReference[]
  stagingDir?: string
}

export type WizardReferenceHost = {
  createStagingDir: (learningBaseDir: string) => Promise<string>
  validateFile: (file: File) => string | null
  writeFile: (
    stagingDir: string,
    file: { name: string; contents: ArrayBuffer },
  ) => Promise<StagedReference>
  removeFile: (vaultPath: string) => Promise<void>
  cleanup: (stagingDir: string) => Promise<void>
}

export function mergeStagedReferences(
  current: readonly StagedReference[],
  incoming: readonly StagedReference[],
): StagedReference[] {
  const incomingPaths = new Set(
    incoming.map((reference) => reference.vaultPath),
  )
  return [
    ...current.filter((reference) => !incomingPaths.has(reference.vaultPath)),
    ...incoming,
  ]
}

export function Wizard({
  learningBaseDir,
  references,
  t,
  onClose,
  onComplete,
}: {
  learningBaseDir: string
  references: WizardReferenceHost
  t: LearningTranslate
  onClose: () => void
  onComplete: (input: LearningWizardInput) => void
}) {
  const [topic, setTopic] = useState('')
  const [goal, setGoal] = useState('')
  const [level, setLevel] = useState<Level>('familiar')
  const [referenceFiles, setReferenceFiles] = useState<StagedReference[]>([])
  const [stagingDir, setStagingDir] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const levels = levelIds.map((id) => ({
    value: id,
    label: t(`learning.wizard.levels.${id}`, id),
  }))

  const closeAndCleanup = () => {
    if (stagingDir) void references.cleanup(stagingDir)
    onClose()
  }

  const handleFiles = async (files: File[]) => {
    setUploadError(null)
    if (files.length === 0) return

    try {
      const dir =
        stagingDir ?? (await references.createStagingDir(learningBaseDir))
      if (!stagingDir) setStagingDir(dir)

      const newRefs: StagedReference[] = []
      for (const file of files) {
        const validationError = references.validateFile(file)
        if (validationError) {
          setUploadError(validationError)
          continue
        }
        newRefs.push(
          await references.writeFile(dir, {
            name: file.name,
            contents: await file.arrayBuffer(),
          }),
        )
      }
      setReferenceFiles((current) => mergeStagedReferences(current, newRefs))
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error))
    }
  }

  const removeReference = async (reference: StagedReference) => {
    setUploadError(null)
    try {
      await references.removeFile(reference.vaultPath)
      setReferenceFiles((current) =>
        current.filter((item) => item.vaultPath !== reference.vaultPath),
      )
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error))
    }
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
            <Sparkles size={16} aria-hidden />
            {t('learning.wizard.createOutline', '创建并生成大纲')}
          </button>
        </>
      }
    >
      <div className="yolo-learning-wizard-step">
        <div className="yolo-learning-wizard-intro">
          <div className="yolo-learning-wizard-intro-icon">
            <Sparkles size={22} aria-hidden />
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
            <div className="yolo-learning-wizard-mode-card yolo-learning-wizard-mode-card-selected">
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
          <div className="yolo-learning-wizard-chip-group">
            {levels.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setLevel(option.value)}
                className={cx(
                  'yolo-learning-wizard-chip',
                  level === option.value &&
                    'yolo-learning-wizard-chip-selected',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
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
          hint={t(
            'learning.wizard.referencesHint',
            '上传后 YOLO 会据此定制大纲',
          )}
          optionalLabel={t('learning.wizard.optional', '（可选）')}
        >
          <LearningFileDropzone
            accept=".pdf,.docx,.doc,.md,.markdown,.txt"
            multiple
            title={t(
              'learning.wizard.uploadTitle',
              '拖拽文件到此处，或点击上传',
            )}
            hint={t(
              'learning.wizard.uploadHint',
              '支持 PDF、Word、Markdown，单个文件 ≤ 20MB',
            )}
            onFiles={handleFiles}
          />
          {uploadError && (
            <div className="yolo-learning-wizard-upload-error" role="alert">
              {uploadError}
            </div>
          )}
          {referenceFiles.length > 0 && (
            <div className="yolo-learning-wizard-upload-list">
              {referenceFiles.map((reference) => (
                <div
                  key={reference.vaultPath}
                  className="yolo-learning-wizard-upload-item"
                >
                  <span className="yolo-learning-wizard-upload-item-name">
                    {reference.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => void removeReference(reference)}
                    className="yolo-learning-wizard-upload-item-remove"
                    aria-label={t('common.remove', '移除')}
                  >
                    <X size={14} aria-hidden />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Field>
      </div>
    </LearningModal>
  )
}

function Field({
  label,
  optionalLabel,
  hint,
  children,
}: {
  label: string
  optionalLabel?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="yolo-learning-wizard-field">
      <div className="yolo-learning-wizard-field-header">
        <div className="yolo-learning-wizard-label">
          {label}
          {optionalLabel && (
            <span className="yolo-learning-wizard-optional">
              {optionalLabel}
            </span>
          )}
        </div>
        {hint && <span className="yolo-learning-wizard-hint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}
