import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { LucideIcon } from 'lucide-react'
import {
  Brain,
  FileText,
  GripVertical,
  Lightbulb,
  ListTodo,
  MessageCircle,
  PenLine,
  Settings,
  Sparkles,
  Table,
  Workflow,
} from 'lucide-react'
import React, { useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianDropdown } from '../common/ObsidianDropdown'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ObsidianTextArea } from '../common/ObsidianTextArea'
import { ObsidianTextInput } from '../common/ObsidianTextInput'
import { ConfirmModal } from '../modals/ConfirmModal'
import { SmartSpaceQuickActionsModal } from './modals/SmartSpaceQuickActionsModal'

type QuickAction = {
  id: string
  label: string
  instruction: string
  icon?: string
  category?: 'suggestions' | 'writing' | 'thinking' | 'custom'
  enabled: boolean
}

type QuickActionCategory = NonNullable<QuickAction['category']>

type TranslateFn = (key: string, fallback?: string) => string

const QUICK_ACTION_CATEGORIES: QuickActionCategory[] = [
  'suggestions',
  'writing',
  'thinking',
  'custom',
]

const isQuickActionCategory = (value: string): value is QuickActionCategory =>
  QUICK_ACTION_CATEGORIES.includes(value as QuickActionCategory)

// Available icons mapping
const ICON_OPTIONS = {
  sparkles: {
    component: Sparkles,
    labelKey: 'settings.smartSpace.iconLabels.sparkles',
    fallback: 'Sparkles',
  },
  filetext: {
    component: FileText,
    labelKey: 'settings.smartSpace.iconLabels.file',
    fallback: 'File',
  },
  listtodo: {
    component: ListTodo,
    labelKey: 'settings.smartSpace.iconLabels.todo',
    fallback: 'Todo',
  },
  workflow: {
    component: Workflow,
    labelKey: 'settings.smartSpace.iconLabels.workflow',
    fallback: 'Workflow',
  },
  table: {
    component: Table,
    labelKey: 'settings.smartSpace.iconLabels.table',
    fallback: 'Table',
  },
  penline: {
    component: PenLine,
    labelKey: 'settings.smartSpace.iconLabels.pen',
    fallback: 'Pen',
  },
  lightbulb: {
    component: Lightbulb,
    labelKey: 'settings.smartSpace.iconLabels.lightbulb',
    fallback: 'Lightbulb',
  },
  brain: {
    component: Brain,
    labelKey: 'settings.smartSpace.iconLabels.brain',
    fallback: 'Brain',
  },
  messagecircle: {
    component: MessageCircle,
    labelKey: 'settings.smartSpace.iconLabels.message',
    fallback: 'Message',
  },
  settings: {
    component: Settings,
    labelKey: 'settings.smartSpace.iconLabels.settings',
    fallback: 'Settings',
  },
}

type DefaultActionConfig = {
  id: string
  icon: string
  category: QuickAction['category']
  labelKey: string
  labelFallback: string
  instructionKey: string
  instructionFallback: string
}

const DEFAULT_ACTION_CONFIGS: DefaultActionConfig[] = [
  {
    id: 'continue',
    icon: 'sparkles',
    category: 'suggestions',
    labelKey: 'chat.customContinueSections.suggestions.items.continue.label',
    labelFallback: '继续编写',
    instructionKey:
      'chat.customContinueSections.suggestions.items.continue.instruction',
    instructionFallback:
      'You are a helpful writing assistant. Continue writing from the provided context without repeating or paraphrasing the context. Match the tone, language, and style. Output only the continuation text.',
  },
  {
    id: 'summarize',
    icon: 'filetext',
    category: 'writing',
    labelKey: 'chat.customContinueSections.writing.items.summarize.label',
    labelFallback: '添加摘要',
    instructionKey:
      'chat.customContinueSections.writing.items.summarize.instruction',
    instructionFallback: '请为当前内容写一个简洁摘要。',
  },
  {
    id: 'todo',
    icon: 'listtodo',
    category: 'writing',
    labelKey: 'chat.customContinueSections.writing.items.todo.label',
    labelFallback: '添加待办事项',
    instructionKey:
      'chat.customContinueSections.writing.items.todo.instruction',
    instructionFallback: '请基于当前内容整理一个可执行的待办清单。',
  },
  {
    id: 'flowchart',
    icon: 'workflow',
    category: 'writing',
    labelKey: 'chat.customContinueSections.writing.items.flowchart.label',
    labelFallback: '制作流程图',
    instructionKey:
      'chat.customContinueSections.writing.items.flowchart.instruction',
    instructionFallback: '请将当前要点整理成流程图或分步骤说明。',
  },
  {
    id: 'table',
    icon: 'table',
    category: 'writing',
    labelKey: 'chat.customContinueSections.writing.items.table.label',
    labelFallback: '制作表格',
    instructionKey:
      'chat.customContinueSections.writing.items.table.instruction',
    instructionFallback: '请把当前信息整理成表格，并给出合适的列标题。',
  },
  {
    id: 'freewrite',
    icon: 'penline',
    category: 'writing',
    labelKey: 'chat.customContinueSections.writing.items.freewrite.label',
    labelFallback: '随心写作',
    instructionKey:
      'chat.customContinueSections.writing.items.freewrite.instruction',
    instructionFallback: '请结合上下文自由发挥，继续创作新的段落。',
  },
  {
    id: 'brainstorm',
    icon: 'lightbulb',
    category: 'thinking',
    labelKey: 'chat.customContinueSections.thinking.items.brainstorm.label',
    labelFallback: '头脑风暴',
    instructionKey:
      'chat.customContinueSections.thinking.items.brainstorm.instruction',
    instructionFallback: '请给出若干新的灵感或切入点。',
  },
  {
    id: 'analyze',
    icon: 'brain',
    category: 'thinking',
    labelKey: 'chat.customContinueSections.thinking.items.analyze.label',
    labelFallback: '分析重点',
    instructionKey:
      'chat.customContinueSections.thinking.items.analyze.instruction',
    instructionFallback: '请简要分析当前内容的要点、风险或机会。',
  },
  {
    id: 'dialogue',
    icon: 'messagecircle',
    category: 'thinking',
    labelKey: 'chat.customContinueSections.thinking.items.dialogue.label',
    labelFallback: '提出追问',
    instructionKey:
      'chat.customContinueSections.thinking.items.dialogue.instruction',
    instructionFallback: '请给出一些深入讨论的追问。',
  },
]

const DEFAULT_ACTION_LOOKUP: Record<string, DefaultActionConfig> =
  Object.fromEntries(
    DEFAULT_ACTION_CONFIGS.map((config) => [config.id, config]),
  )

// Generate unique ID
const generateId = () => {
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

const getDefaultQuickActions = (t: TranslateFn): QuickAction[] => {
  return DEFAULT_ACTION_CONFIGS.map((config) => ({
    id: config.id,
    label: t(config.labelKey, config.labelFallback),
    instruction: t(config.instructionKey, config.instructionFallback),
    icon: config.icon,
    category: config.category,
    enabled: true,
  }))
}

// Category display order
const CATEGORY_ORDER: QuickAction['category'][] = [...QUICK_ACTION_CATEGORIES]

type GroupedActions = {
  category: QuickAction['category']
  actions: QuickAction[]
}

export function SmartSpaceQuickActionsSettings() {
  const plugin = usePlugin()
  const { settings } = useSettings()
  const { t } = useLanguage()
  const quickActions =
    settings.continuationOptions.smartSpaceQuickActions ||
    getDefaultQuickActions(t)
  const actionsCountLabel = t(
    'settings.smartSpace.actionsCount',
    '已配置 {count} 个快捷选项',
  ).replace('{count}', String(quickActions.length))

  return (
    <div className="smtcmp-smart-space-settings">
      <ObsidianSetting
        name={t(
          'settings.smartSpace.quickActionsTitle',
          'Smart Space 快捷选项',
        )}
        desc={t(
          'settings.smartSpace.quickActionsDesc',
          '自定义 Smart Space 中显示的快捷选项和提示词',
        )}
      >
        <div className="smtcmp-settings-desc">{actionsCountLabel}</div>
        <ObsidianButton
          text={t('settings.smartSpace.configureActions', '配置快捷选项')}
          onClick={() => {
            const modal = new SmartSpaceQuickActionsModal(plugin.app, plugin)
            modal.open()
          }}
        />
      </ObsidianSetting>
    </div>
  )
}

export function SmartSpaceQuickActionsSettingsContent() {
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const categoryOptions = useMemo(
    () => ({
      suggestions: t('settings.smartSpace.categories.suggestions', '建议'),
      writing: t('settings.smartSpace.categories.writing', '撰写'),
      thinking: t(
        'settings.smartSpace.categories.thinking',
        '思考 · 询问 · 对话',
      ),
      custom: t('settings.smartSpace.categories.custom', '自定义'),
    }),
    [t],
  )
  const iconOptions = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(ICON_OPTIONS).map(([key, value]) => [
          key,
          t(value.labelKey, value.fallback),
        ]),
      ),
    [t],
  )
  const [editingAction, setEditingAction] = useState<QuickAction | null>(null)
  const [isAddingAction, setIsAddingAction] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  // Get current quick actions, or use default ones if not customized
  const quickActions = (
    settings.continuationOptions.smartSpaceQuickActions ||
    getDefaultQuickActions(t)
  ).map((action) => {
    const config = DEFAULT_ACTION_LOOKUP[action.id]
    let label = action.label
    let instruction = action.instruction

    if (config) {
      const localizedLabel = t(config.labelKey, config.labelFallback)
      const localizedInstruction = t(
        config.instructionKey,
        config.instructionFallback,
      )

      if (
        label === config.labelFallback ||
        label === localizedLabel ||
        !label
      ) {
        label = localizedLabel
      }

      if (
        instruction === config.instructionFallback ||
        instruction === localizedInstruction ||
        !instruction
      ) {
        instruction = localizedInstruction
      }
    }

    return {
      ...action,
      label,
      instruction,
      enabled: true,
    }
  })

  // Group actions by category
  const groupedActions: GroupedActions[] = useMemo(() => {
    return CATEGORY_ORDER.map((category) => ({
      category,
      actions: quickActions.filter((action) => action.category === category),
    })).filter((group) => group.actions.length > 0)
  }, [quickActions])
  const quickActionIds = quickActions.map((action) => action.id)

  const handleSaveActions = async (newActions: QuickAction[]) => {
    await setSettings({
      ...settings,
      continuationOptions: {
        ...settings.continuationOptions,
        smartSpaceQuickActions: newActions.map((action) => ({
          ...action,
          enabled: true,
        })),
      },
    })
  }

  const handleAddAction = () => {
    const newAction: QuickAction = {
      id: generateId(),
      label: '',
      instruction: '',
      icon: 'sparkles',
      category: 'custom',
      enabled: true,
    }
    setEditingAction(newAction)
    setIsAddingAction(true)
  }

  const handleSaveAction = async () => {
    if (!editingAction || !editingAction.label || !editingAction.instruction) {
      return
    }

    let newActions: QuickAction[]
    if (isAddingAction) {
      newActions = [...quickActions, { ...editingAction, enabled: true }]
    } else {
      newActions = quickActions.map((action) =>
        action.id === editingAction.id
          ? { ...editingAction, enabled: true }
          : { ...action, enabled: true },
      )
    }

    try {
      await handleSaveActions(newActions)
      setEditingAction(null)
      setIsAddingAction(false)
    } catch (error: unknown) {
      console.error('Failed to save Smart Space quick action', error)
    }
  }

  const handleDeleteAction = async (id: string) => {
    const newActions = quickActions.filter((action) => action.id !== id)
    try {
      await handleSaveActions(newActions)
    } catch (error: unknown) {
      console.error('Failed to delete Smart Space quick action', error)
    }
  }

  const handleDuplicateAction = async (action: QuickAction) => {
    const newAction = {
      ...action,
      id: generateId(),
      label: `${action.label}${t('settings.smartSpace.copySuffix', ' (副本)')}`,
      enabled: true,
    }
    const newActions = [...quickActions, newAction]
    try {
      await handleSaveActions(newActions)
    } catch (error: unknown) {
      console.error('Failed to duplicate Smart Space quick action', error)
    }
  }

  const triggerDropSuccess = (movedId: string) => {
    const tryFind = (attempt = 0) => {
      const movedItem = document.querySelector(
        `div[data-action-id="${movedId}"]`,
      )
      if (movedItem) {
        movedItem.classList.add('smtcmp-quick-action-drop-success')
        window.setTimeout(() => {
          movedItem.classList.remove('smtcmp-quick-action-drop-success')
        }, 700)
      } else if (attempt < 8) {
        window.setTimeout(() => tryFind(attempt + 1), 50)
      }
    }
    requestAnimationFrame(() => tryFind())
  }

  const handleQuickActionDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return
    }

    const oldIndex = quickActions.findIndex((action) => action.id === active.id)
    const newIndex = quickActions.findIndex((action) => action.id === over.id)
    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    const targetCategory =
      quickActions[newIndex]?.category ?? quickActions[oldIndex]?.category

    const reorderedActions = arrayMove(quickActions, oldIndex, newIndex)
    reorderedActions[newIndex] = {
      ...reorderedActions[newIndex],
      category: targetCategory,
    }

    try {
      await handleSaveActions(reorderedActions)
      triggerDropSuccess(String(active.id))
    } catch (error: unknown) {
      console.error('Failed to reorder Smart Space actions', error)
    }
  }

  const handleResetToDefault = () => {
    let confirmed = false

    const modal = new ConfirmModal(plugin.app, {
      title: t(
        'settings.smartSpace.resetConfirmTitle',
        'Reset Smart Space actions',
      ),
      message: t(
        'settings.smartSpace.confirmReset',
        '确定要恢复默认的快捷选项吗？这将删除所有自定义设置。',
      ),
      ctaText: t('common.confirm'),
      onConfirm: () => {
        confirmed = true
      },
    })

    modal.onClose = () => {
      if (!confirmed) return
      Promise.resolve(
        setSettings({
          ...settings,
          continuationOptions: {
            ...settings.continuationOptions,
            smartSpaceQuickActions: undefined,
          },
        }),
      ).catch((error: unknown) => {
        console.error('Failed to reset Smart Space quick actions', error)
      })
    }

    modal.open()
  }

  return (
    <div className="smtcmp-smart-space-settings">
      <ObsidianSetting
        name={t(
          'settings.smartSpace.quickActionsTitle',
          'Smart Space 快捷选项',
        )}
        desc={t(
          'settings.smartSpace.quickActionsDesc',
          '自定义 Smart Space 中显示的快捷选项和提示词',
        )}
      >
        <ObsidianButton
          text={t('settings.smartSpace.addAction', '添加选项')}
          onClick={handleAddAction}
        />
        <ObsidianButton
          text={t('settings.smartSpace.resetToDefault', '恢复默认')}
          onClick={handleResetToDefault}
        />
      </ObsidianSetting>

      {/* Add new action form (shown at top when adding) */}
      {isAddingAction && editingAction && (
        <div className="smtcmp-quick-action-editor smtcmp-quick-action-editor-new">
          <ObsidianSetting
            name={t('settings.smartSpace.actionLabel', '选项名称')}
            desc={t(
              'settings.smartSpace.actionLabelDesc',
              '显示在快捷选项中的文本',
            )}
          >
            <ObsidianTextInput
              value={editingAction.label}
              placeholder={t(
                'settings.smartSpace.actionLabelPlaceholder',
                '例如：继续编写',
              )}
              onChange={(value) =>
                setEditingAction({ ...editingAction, label: value })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.smartSpace.actionInstruction', '提示词')}
            desc={t(
              'settings.smartSpace.actionInstructionDesc',
              '发送给 AI 的指令',
            )}
            className="smtcmp-settings-textarea-header"
          />
          <ObsidianSetting className="smtcmp-settings-textarea">
            <ObsidianTextArea
              value={editingAction.instruction}
              placeholder={t(
                'settings.smartSpace.actionInstructionPlaceholder',
                '例如：请继续扩展当前段落，保持原有语气与风格。',
              )}
              onChange={(value) =>
                setEditingAction({ ...editingAction, instruction: value })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.smartSpace.actionCategory', '分类')}
            desc={t('settings.smartSpace.actionCategoryDesc', '选项所属的分类')}
          >
            <ObsidianDropdown
              value={editingAction.category || 'custom'}
              options={categoryOptions}
              onChange={(value) =>
                setEditingAction({
                  ...editingAction,
                  category: isQuickActionCategory(value) ? value : 'custom',
                })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.smartSpace.actionIcon', '图标')}
            desc={t('settings.smartSpace.actionIconDesc', '选择一个图标')}
          >
            <ObsidianDropdown
              value={editingAction.icon || 'sparkles'}
              options={iconOptions}
              onChange={(value) =>
                setEditingAction({ ...editingAction, icon: value })
              }
            />
          </ObsidianSetting>

          <div className="smtcmp-quick-action-editor-buttons">
            <ObsidianButton
              text={t('common.save', '保存')}
              onClick={() => void handleSaveAction()}
              cta
              disabled={!editingAction.label || !editingAction.instruction}
            />
            <ObsidianButton
              text={t('common.cancel', '取消')}
              onClick={() => {
                setEditingAction(null)
                setIsAddingAction(false)
              }}
            />
          </div>
        </div>
      )}

      {/* Quick Actions List - Grouped by Category */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void handleQuickActionDragEnd(event)}
      >
        <SortableContext
          items={quickActionIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="smtcmp-quick-actions-list">
            {groupedActions.map((group, groupIndex) => (
              <React.Fragment key={group.category}>
                <div className="smtcmp-quick-actions-group-header">
                  {categoryOptions[group.category || 'custom']}
                </div>

                {group.actions.map((action) => {
                  const IconComponent =
                    ICON_OPTIONS[action.icon as keyof typeof ICON_OPTIONS]
                      ?.component || Sparkles
                  const isEditing =
                    !isAddingAction && editingAction?.id === action.id

                  return (
                    <QuickActionItem
                      key={action.id}
                      action={action}
                      iconComponent={IconComponent}
                      isEditing={isEditing}
                      editingAction={editingAction}
                      setEditingAction={setEditingAction}
                      setIsAddingAction={setIsAddingAction}
                      handleDuplicateAction={handleDuplicateAction}
                      handleDeleteAction={handleDeleteAction}
                      handleSaveAction={handleSaveAction}
                      categoryOptions={categoryOptions}
                      iconOptions={iconOptions}
                      t={t}
                    />
                  )
                })}

                {groupIndex < groupedActions.length - 1 && (
                  <div className="smtcmp-quick-actions-group-divider" />
                )}
              </React.Fragment>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

type QuickActionItemProps = {
  action: QuickAction
  iconComponent: LucideIcon
  isEditing: boolean
  editingAction: QuickAction | null
  setEditingAction: React.Dispatch<React.SetStateAction<QuickAction | null>>
  setIsAddingAction: React.Dispatch<React.SetStateAction<boolean>>
  handleDuplicateAction: (action: QuickAction) => void | Promise<void>
  handleDeleteAction: (id: string) => void | Promise<void>
  handleSaveAction: () => void | Promise<void>
  categoryOptions: Record<string, string>
  iconOptions: Record<string, string>
  t: TranslateFn
}

function QuickActionItem({
  action,
  iconComponent: IconComponent,
  isEditing,
  editingAction,
  setEditingAction,
  setIsAddingAction,
  handleDuplicateAction,
  handleDeleteAction,
  handleSaveAction,
  categoryOptions,
  iconOptions,
  t,
}: QuickActionItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: action.id, disabled: isEditing })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const currentEditing = isEditing ? editingAction : null

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        data-action-id={action.id}
        className={`smtcmp-quick-action-item ${isEditing ? 'editing' : ''} ${isDragging ? 'smtcmp-quick-action-dragging' : ''}`}
        {...attributes}
      >
        <div className="smtcmp-quick-action-drag-handle">
          <span
            className={`smtcmp-drag-handle ${isDragging ? 'smtcmp-drag-handle--active' : ''}`}
            aria-label={t('settings.smartSpace.dragHandleAria', '拖拽排序')}
            {...listeners}
          >
            <GripVertical size={16} />
          </span>
        </div>
        <div className="smtcmp-quick-action-content">
          <div className="smtcmp-quick-action-header">
            <IconComponent size={16} className="smtcmp-quick-action-icon" />
            <span className="smtcmp-quick-action-label">{action.label}</span>
          </div>
        </div>
        <div className="smtcmp-quick-action-controls">
          <ObsidianButton
            onClick={() => {
              if (isEditing) {
                setEditingAction(null)
              } else {
                setEditingAction(action)
                setIsAddingAction(false)
              }
            }}
            icon={isEditing ? 'x' : 'pencil'}
            tooltip={
              isEditing ? t('common.cancel', '取消') : t('common.edit', '编辑')
            }
          />
          <ObsidianButton
            onClick={() => void handleDuplicateAction(action)}
            icon="copy"
            tooltip={t('settings.smartSpace.duplicate', '复制')}
          />
          <ObsidianButton
            onClick={() => void handleDeleteAction(action.id)}
            icon="trash-2"
            tooltip={t('common.delete', '删除')}
          />
        </div>
      </div>

      {isEditing && currentEditing && (
        <div className="smtcmp-quick-action-editor smtcmp-quick-action-editor-inline">
          <ObsidianSetting
            name={t('settings.smartSpace.actionLabel', '选项名称')}
            desc={t(
              'settings.smartSpace.actionLabelDesc',
              '显示在快捷选项中的文本',
            )}
          >
            <ObsidianTextInput
              value={currentEditing.label}
              placeholder={t(
                'settings.smartSpace.actionLabelPlaceholder',
                '例如：继续编写',
              )}
              onChange={(value) =>
                setEditingAction({
                  ...currentEditing,
                  label: value,
                })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.smartSpace.actionInstruction', '提示词')}
            desc={t(
              'settings.smartSpace.actionInstructionDesc',
              '发送给 AI 的指令',
            )}
            className="smtcmp-settings-textarea-header"
          />
          <ObsidianSetting className="smtcmp-settings-textarea">
            <ObsidianTextArea
              value={currentEditing.instruction}
              placeholder={t(
                'settings.smartSpace.actionInstructionPlaceholder',
                '例如：请继续扩展当前段落，保持原有语气与风格。',
              )}
              onChange={(value) =>
                setEditingAction({
                  ...currentEditing,
                  instruction: value,
                })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.smartSpace.actionCategory', '分类')}
            desc={t('settings.smartSpace.actionCategoryDesc', '选项所属的分类')}
          >
            <ObsidianDropdown
              value={currentEditing.category || 'custom'}
              options={categoryOptions}
              onChange={(value) =>
                setEditingAction({
                  ...currentEditing,
                  category: isQuickActionCategory(value) ? value : 'custom',
                })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.smartSpace.actionIcon', '图标')}
            desc={t('settings.smartSpace.actionIconDesc', '选择一个图标')}
          >
            <ObsidianDropdown
              value={currentEditing.icon || 'sparkles'}
              options={iconOptions}
              onChange={(value) =>
                setEditingAction({
                  ...currentEditing,
                  icon: value,
                })
              }
            />
          </ObsidianSetting>

          <div className="smtcmp-quick-action-editor-buttons">
            <ObsidianButton
              text={t('common.save', '保存')}
              onClick={() => void handleSaveAction()}
              cta
              disabled={!currentEditing.label || !currentEditing.instruction}
            />
            <ObsidianButton
              text={t('common.cancel', '取消')}
              onClick={() => {
                setEditingAction(null)
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
