import cx from 'clsx'
import { Sparkles, Upload, X } from 'lucide-react'
import type React from 'react'
import { useState } from 'react'

import { useLanguage } from '../../contexts/language-context'

const levelIds = ['beginner', 'familiar', 'experienced', 'advanced'] as const

export function Wizard({
  onClose,
  onComplete,
}: {
  onClose: () => void
  onComplete: () => void
}) {
  const { t } = useLanguage()
  const levels = levelIds.map((id) => ({
    value: id,
    label: t(`learning.wizard.levels.${id}`, id),
  }))
  const styles = [
    {
      id: 'exam',
      title: t('learning.wizard.styles.exam.title', '考试导向'),
      desc: t(
        'learning.wizard.styles.exam.desc',
        '围绕考点与真题，强化记忆与解题',
      ),
    },
    {
      id: 'project',
      title: t('learning.wizard.styles.project.title', '项目导向'),
      desc: t(
        'learning.wizard.styles.project.desc',
        '以动手项目驱动，边做边学',
      ),
    },
    {
      id: 'system',
      title: t('learning.wizard.styles.system.title', '系统学习'),
      desc: t('learning.wizard.styles.system.desc', '完整知识体系，循序渐进'),
    },
    {
      id: 'quick',
      title: t('learning.wizard.styles.quick.title', '快速入门'),
      desc: t('learning.wizard.styles.quick.desc', '最短路径建立全局认知'),
    },
  ]
  const [topic, setTopic] = useState(() =>
    t('learning.wizard.topicDefault', '学习 React'),
  )
  const [goal, setGoal] = useState(() =>
    t('learning.wizard.goalDefault', '能够独立开发中等复杂度的 React 应用'),
  )
  const [level, setLevel] = useState<(typeof levelIds)[number]>('familiar')
  const [style, setStyle] = useState(styles[1].id)

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
            style={style}
            setStyle={setStyle}
            styles={styles}
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
            onClick={onComplete}
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
  style,
  setStyle,
  styles,
  levels,
  t,
}: {
  topic: string
  setTopic: (value: string) => void
  goal: string
  setGoal: (value: string) => void
  level: (typeof levelIds)[number]
  setLevel: (value: (typeof levelIds)[number]) => void
  style: string
  setStyle: (value: string) => void
  styles: { id: string; title: string; desc: string }[]
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

      <Field label={t('learning.wizard.levelLabel', '当前水平')}>
        <ChipGroup options={levels} value={level} onChange={setLevel} />
      </Field>

      <Field
        label={t('learning.wizard.goalLabel', '学习目标')}
        hint={t('learning.wizard.goalHint', '你希望达到什么程度？')}
      >
        <textarea
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          rows={3}
          placeholder={t(
            'learning.wizard.goalPlaceholder',
            '能够独立开发中等复杂度的 React 应用',
          )}
          className="yolo-learning-wizard-textarea"
        />
      </Field>

      <Field label={t('learning.wizard.styleLabel', '偏好的学习方式')}>
        <div className="yolo-learning-wizard-style-grid">
          {styles.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setStyle(option.id)}
              className={cx(
                'yolo-learning-wizard-style-card',
                style === option.id &&
                  'yolo-learning-wizard-style-card-selected',
              )}
            >
              <div className="yolo-learning-wizard-style-title">
                {option.title}
              </div>
              <div className="yolo-learning-wizard-style-description">
                {option.desc}
              </div>
            </button>
          ))}
        </div>
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
