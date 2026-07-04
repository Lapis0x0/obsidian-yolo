import cx from 'clsx'
import { Sparkles, Upload, X } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'

import { useLanguage } from '../../contexts/language-context'

const levelIds = ['beginner', 'familiar', 'experienced', 'advanced'] as const

export type LearningWizardInput = {
  topic: string
  level: string
  goal: string
}

export function Wizard({
  onClose,
  onComplete,
}: {
  onClose: () => void
  onComplete: (input: LearningWizardInput) => void
}) {
  const { t } = useLanguage()
  const levels = levelIds.map((id) => ({
    value: id,
    label: t(`learning.wizard.levels.${id}`, id),
  }))
  const [topic, setTopic] = useState(() =>
    t('learning.wizard.topicDefault', '学习 React'),
  )
  const [goal, setGoal] = useState(() =>
    t('learning.wizard.goalDefault', '能够独立开发中等复杂度的 React 应用'),
  )
  const [level, setLevel] = useState<(typeof levelIds)[number]>('familiar')

  return (
    <div className="yolo-learning-wizard-overlay">
      <div
        className="yolo-learning-wizard-backdrop"
        onClick={onClose}
        aria-hidden
      />
      <div className="yolo-learning-wizard-dialog">
        <div className="yolo-learning-wizard-header">
          <div className="yolo-learning-wizard-title">
            {t('learning.wizard.title', '新建学习项目')}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="yolo-learning-wizard-close"
            aria-label={t('common.close', '关闭')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="yolo-learning-wizard-body yolo-learning-scrollbar-thin">
          <StepOne
            topic={topic}
            setTopic={setTopic}
            goal={goal}
            setGoal={setGoal}
            level={level}
            setLevel={setLevel}
            levels={levels}
            t={t}
          />
        </div>

        <div className="yolo-learning-wizard-footer">
          <button
            type="button"
            onClick={onClose}
            className="yolo-learning-wizard-cancel"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            onClick={() => onComplete({ topic, level, goal })}
            className="yolo-learning-wizard-primary"
          >
            <Sparkles size={16} />
            {t('learning.wizard.createOutline', '创建并生成大纲')}
          </button>
        </div>
      </div>
    </div>
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
  t,
}: {
  topic: string
  setTopic: (value: string) => void
  goal: string
  setGoal: (value: string) => void
  level: (typeof levelIds)[number]
  setLevel: (value: (typeof levelIds)[number]) => void
  levels: { value: (typeof levelIds)[number]; label: string }[]
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
        <div className="yolo-learning-wizard-upload">
          <div className="yolo-learning-wizard-upload-icon">
            <Upload size={18} />
          </div>
          <div className="yolo-learning-wizard-upload-copy">
            <div className="yolo-learning-wizard-upload-title">
              {t('learning.wizard.uploadTitle', '拖拽文件到此处，或点击上传')}
            </div>
            <div className="yolo-learning-wizard-upload-hint">
              {t(
                'learning.wizard.uploadHint',
                '支持 PDF、Word、Markdown，单个文件 ≤ 20MB',
              )}
            </div>
          </div>
        </div>
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
