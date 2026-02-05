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
import { GripVertical } from 'lucide-react'
import React, { useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianDropdown } from '../common/ObsidianDropdown'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ObsidianTextArea } from '../common/ObsidianTextArea'
import { ObsidianTextInput } from '../common/ObsidianTextInput'
import { ConfirmModal } from '../modals/ConfirmModal'

import { SelectionChatActionsModal } from './modals/SelectionChatActionsModal'

type SelectionChatAction = {
  id: string
  label: string
  instruction: string
  enabled: boolean
  mode?: SelectionChatActionMode
  rewriteBehavior?: SelectionChatActionRewriteBehavior
}

type SelectionChatActionMode = 'ask' | 'rewrite'
type SelectionChatActionRewriteBehavior = 'custom' | 'preset'

type TranslateFn = (key: string, fallback?: string) => string

type DefaultActionConfig = {
  id: string
  labelKey: string
  labelFallback: string
  mode?: SelectionChatActionMode
  rewriteBehavior?: SelectionChatActionRewriteBehavior
  allowEmptyInstruction?: boolean
}

const DEFAULT_ACTION_CONFIGS: DefaultActionConfig[] = [
  {
    id: 'explain',
    labelKey: 'selection.actions.explain',
    labelFallback: '深入解释',
    mode: 'ask',
  },
  {
    id: 'suggest',
    labelKey: 'selection.actions.suggest',
    labelFallback: '提供建议',
    mode: 'ask',
  },
  {
    id: 'translate-to-chinese',
    labelKey: 'selection.actions.translateToChinese',
    labelFallback: '翻译成中文',
    mode: 'ask',
  },
]

const FIXED_ACTION_IDS = new Set(['custom-rewrite'])

const DEFAULT_ACTION_LOOKUP: Record<string, DefaultActionConfig> =
  Object.fromEntries(
    DEFAULT_ACTION_CONFIGS.map((config) => [config.id, config]),
  )

const resolveSelectionActionMode = (
  action: SelectionChatAction,
): SelectionChatActionMode => {
  if (action.mode) return action.mode
  if (action.id === 'rewrite' || action.id === 'custom-rewrite') {
    return 'rewrite'
  }
  return 'ask'
}

const resolveRewriteBehavior = (
  action: SelectionChatAction,
  mode: SelectionChatActionMode,
): SelectionChatActionRewriteBehavior | undefined => {
  if (mode !== 'rewrite') return undefined
  if (action.rewriteBehavior) return action.rewriteBehavior
  if (action.id === 'custom-rewrite') return 'custom'
  return 'preset'
}

const generateId = () => {
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

const getDefaultSelectionChatActions = (
  t: TranslateFn,
): SelectionChatAction[] => {
  return DEFAULT_ACTION_CONFIGS.map((config) => {
    const label = t(config.labelKey, config.labelFallback)
    return {
      id: config.id,
      label,
      instruction: config.allowEmptyInstruction ? '' : label,
      enabled: true,
      mode: config.mode ?? 'ask',
      rewriteBehavior: config.rewriteBehavior,
    }
  })
}

type SelectionChatActionsSettingsProps = {
  variant?: 'settings' | 'composer'
}

export function SelectionChatActionsSettings({
  variant = 'settings',
}: SelectionChatActionsSettingsProps) {
  const plugin = usePlugin()
  const { settings } = useSettings()
  const { t } = useLanguage()
  const selectionChatActions =
    settings.continuationOptions.selectionChatActions ||
    getDefaultSelectionChatActions(t)
  const actionsCountLabel = t(
    'settings.selectionChat.actionsCount',
    '已配置 {count} 个快捷选项',
  ).replace(
    '{count}',
    String(
      selectionChatActions.filter((action) => !FIXED_ACTION_IDS.has(action.id))
        .length,
    ),
  )
  const handleOpenModal = () => {
    const modal = new SelectionChatActionsModal(plugin.app, plugin)
    modal.open()
  }

  if (variant === 'composer') {
    return (
      <div className="smtcmp-smart-space-settings">
        <div className="smtcmp-smart-space-settings-row">
          <div className="smtcmp-settings-desc">{actionsCountLabel}</div>
          <ObsidianButton
            text={t('settings.selectionChat.configureActions', '配置快捷选项')}
            onClick={handleOpenModal}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="smtcmp-smart-space-settings">
      <ObsidianSetting
        name={t(
          'settings.selectionChat.quickActionsTitle',
          'Cursor Chat 快捷选项',
        )}
        desc={t(
          'settings.selectionChat.quickActionsDesc',
          '自定义选中文本后显示的快捷选项和提示词',
        )}
      >
        <div className="smtcmp-settings-desc">{actionsCountLabel}</div>
        <ObsidianButton
          text={t('settings.selectionChat.configureActions', '配置快捷选项')}
          onClick={handleOpenModal}
        />
      </ObsidianSetting>
    </div>
  )
}

export function SelectionChatActionsSettingsContent() {
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [editingAction, setEditingAction] =
    useState<SelectionChatAction | null>(null)
  const [isAddingAction, setIsAddingAction] = useState(false)
  const actionModeOptions: Record<SelectionChatActionMode, string> = {
    ask: t('settings.selectionChat.actionModeAsk', '问答（Quick Ask）'),
    rewrite: t('settings.selectionChat.actionModeRewrite', '改写（生成预览）'),
  }
  const actionRewriteTypeOptions: Record<
    SelectionChatActionRewriteBehavior,
    string
  > = {
    custom: t(
      'settings.selectionChat.actionRewriteTypeCustom',
      '自定义指令（弹出输入）',
    ),
    preset: t(
      'settings.selectionChat.actionRewriteTypePreset',
      '预置指令（直接生成）',
    ),
  }
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  const selectionChatActions = (
    settings.continuationOptions.selectionChatActions ||
    getDefaultSelectionChatActions(t)
  ).map((action) => {
    const config = DEFAULT_ACTION_LOOKUP[action.id]
    let label = action.label
    let instruction = action.instruction
    const mode = resolveSelectionActionMode(action)
    const rewriteBehavior = resolveRewriteBehavior(action, mode)

    if (config) {
      const localizedLabel = t(config.labelKey, config.labelFallback)
      if (
        label === config.labelFallback ||
        label === localizedLabel ||
        !label
      ) {
        label = localizedLabel
      }
      if (
        (mode !== 'rewrite' || rewriteBehavior === 'preset') &&
        (instruction === config.labelFallback ||
          instruction === localizedLabel ||
          !instruction)
      ) {
        instruction = localizedLabel
      }
    }

    return {
      ...action,
      label,
      instruction,
      enabled: true,
      mode,
      rewriteBehavior,
    }
  })

  const editableActions = selectionChatActions.filter(
    (action: SelectionChatAction) => !FIXED_ACTION_IDS.has(action.id),
  )

  const getInstructionDesc = (mode: SelectionChatActionMode) =>
    mode === 'rewrite'
      ? t(
          'settings.selectionChat.actionInstructionRewriteDesc',
          '改写指令（仅在“预置指令”类型时必填）',
        )
      : t('settings.selectionChat.actionInstructionDesc', '发送给 AI 的指令')

  const getInstructionPlaceholder = (mode: SelectionChatActionMode) =>
    mode === 'rewrite'
      ? t(
          'settings.selectionChat.actionInstructionRewritePlaceholder',
          '例如：语气更简洁，保留 Markdown 结构。',
        )
      : t(
          'settings.selectionChat.actionInstructionPlaceholder',
          '例如：请深入解释选中的内容。',
        )

  const canSaveAction = (action: SelectionChatAction | null) => {
    if (!action) return false
    const mode = action.mode ?? 'ask'
    const rewriteBehavior = action.rewriteBehavior ?? 'preset'
    const hasLabel = Boolean(action.label?.trim())
    const hasInstruction = Boolean(action.instruction?.trim())
    if (mode === 'rewrite') {
      return rewriteBehavior === 'preset'
        ? hasLabel && hasInstruction
        : hasLabel
    }
    return hasLabel && hasInstruction
  }

  const actionIds = editableActions.map((action) => action.id)

  const handleSaveActions = async (newActions: SelectionChatAction[]) => {
    await setSettings({
      ...settings,
      continuationOptions: {
        ...settings.continuationOptions,
        selectionChatActions: newActions.map((action) => ({
          ...action,
          enabled: true,
        })),
      },
    })
  }

  const handleAddAction = () => {
    const newAction: SelectionChatAction = {
      id: generateId(),
      label: '',
      instruction: '',
      enabled: true,
      mode: 'ask',
      rewriteBehavior: 'preset',
    }
    setEditingAction(newAction)
    setIsAddingAction(true)
  }

  const handleSaveAction = async () => {
    const mode = editingAction?.mode ?? 'ask'
    const rewriteBehavior = editingAction?.rewriteBehavior ?? 'preset'
    const hasLabel = Boolean(editingAction?.label?.trim())
    const hasInstruction = Boolean(editingAction?.instruction?.trim())
    if (
      !editingAction ||
      !hasLabel ||
      (mode === 'rewrite'
        ? rewriteBehavior === 'preset' && !hasInstruction
        : !hasInstruction)
    ) {
      return
    }

    let newActions: SelectionChatAction[]
    if (isAddingAction) {
      newActions = [...editableActions, { ...editingAction, enabled: true }]
    } else {
      newActions = editableActions.map((action) =>
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
      console.error('Failed to save Cursor Chat quick action', error)
    }
  }

  const handleDeleteAction = async (id: string) => {
    const newActions = editableActions.filter((action) => action.id !== id)
    try {
      await handleSaveActions(newActions)
    } catch (error: unknown) {
      console.error('Failed to delete Cursor Chat quick action', error)
    }
  }

  const handleDuplicateAction = async (action: SelectionChatAction) => {
    const newAction = {
      ...action,
      id: generateId(),
      label: `${action.label}${t('settings.selectionChat.copySuffix', ' (副本)')}`,
      enabled: true,
    }
    const newActions = [...editableActions, newAction]
    try {
      await handleSaveActions(newActions)
    } catch (error: unknown) {
      console.error('Failed to duplicate Cursor Chat quick action', error)
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

    const oldIndex = editableActions.findIndex(
      (action) => action.id === active.id,
    )
    const newIndex = editableActions.findIndex(
      (action) => action.id === over.id,
    )
    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    const reorderedActions = arrayMove(editableActions, oldIndex, newIndex)

    try {
      await handleSaveActions(reorderedActions)
      triggerDropSuccess(String(active.id))
    } catch (error: unknown) {
      console.error('Failed to reorder Cursor Chat actions', error)
    }
  }

  const handleResetToDefault = () => {
    let confirmed = false

    const modal = new ConfirmModal(plugin.app, {
      title: t(
        'settings.selectionChat.resetConfirmTitle',
        'Reset Cursor Chat actions',
      ),
      message: t(
        'settings.selectionChat.confirmReset',
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
            selectionChatActions: undefined,
          },
        }),
      ).catch((error: unknown) => {
        console.error('Failed to reset Cursor Chat quick actions', error)
      })
    }

    modal.open()
  }

  return (
    <div className="smtcmp-smart-space-settings">
      <ObsidianSetting
        name={t(
          'settings.selectionChat.quickActionsTitle',
          'Cursor Chat 快捷选项',
        )}
        desc={t(
          'settings.selectionChat.quickActionsDesc',
          '自定义选中文本后显示的快捷选项和提示词',
        )}
      >
        <ObsidianButton
          text={t('settings.selectionChat.addAction', '添加选项')}
          onClick={handleAddAction}
        />
        <ObsidianButton
          text={t('settings.selectionChat.resetToDefault', '恢复默认')}
          onClick={handleResetToDefault}
        />
      </ObsidianSetting>

      {isAddingAction && editingAction && (
        <div className="smtcmp-quick-action-editor smtcmp-quick-action-editor-new">
          <ObsidianSetting
            name={t('settings.selectionChat.actionLabel', '选项名称')}
            desc={t(
              'settings.selectionChat.actionLabelDesc',
              '显示在快捷选项中的文本',
            )}
          >
            <ObsidianTextInput
              value={editingAction.label}
              placeholder={t(
                'settings.selectionChat.actionLabelPlaceholder',
                '例如：深入解释',
              )}
              onChange={(value) =>
                setEditingAction({ ...editingAction, label: value })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.selectionChat.actionMode', '执行方式')}
            desc={t(
              'settings.selectionChat.actionModeDesc',
              '问答会打开 Quick Ask 并自动发送；改写会打开 Quick Ask 的编辑模式生成预览。',
            )}
          >
            <ObsidianDropdown
              value={editingAction.mode ?? 'ask'}
              options={actionModeOptions}
              onChange={(value) =>
                setEditingAction({
                  ...editingAction,
                  mode: value === 'rewrite' ? 'rewrite' : 'ask',
                  rewriteBehavior:
                    value === 'rewrite'
                      ? (editingAction.rewriteBehavior ?? 'preset')
                      : editingAction.rewriteBehavior,
                })
              }
            />
          </ObsidianSetting>

          {(editingAction.mode ?? 'ask') === 'rewrite' && (
            <ObsidianSetting
              name={t('settings.selectionChat.actionRewriteType', '改写类型')}
              desc={t(
                'settings.selectionChat.actionRewriteTypeDesc',
                '选择改写是否需要输入指令',
              )}
            >
              <ObsidianDropdown
                value={editingAction.rewriteBehavior ?? 'preset'}
                options={actionRewriteTypeOptions}
                onChange={(value) =>
                  setEditingAction({
                    ...editingAction,
                    rewriteBehavior: value === 'custom' ? 'custom' : 'preset',
                  })
                }
              />
            </ObsidianSetting>
          )}

          <ObsidianSetting
            name={t('settings.selectionChat.actionInstruction', '提示词')}
            desc={getInstructionDesc(editingAction.mode ?? 'ask')}
            className="smtcmp-settings-textarea-header"
          />
          <ObsidianSetting className="smtcmp-settings-textarea">
            <ObsidianTextArea
              value={editingAction.instruction}
              placeholder={getInstructionPlaceholder(
                editingAction.mode ?? 'ask',
              )}
              onChange={(value) =>
                setEditingAction({ ...editingAction, instruction: value })
              }
            />
          </ObsidianSetting>

          <div className="smtcmp-quick-action-editor-buttons">
            <ObsidianButton
              text={t('common.save', '保存')}
              onClick={() => void handleSaveAction()}
              cta
              disabled={!canSaveAction(editingAction)}
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

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void handleQuickActionDragEnd(event)}
      >
        <SortableContext
          items={actionIds}
          strategy={verticalListSortingStrategy}
        >
          <div className="smtcmp-quick-actions-list">
            {editableActions.map((action) => {
              const isEditing =
                !isAddingAction && editingAction?.id === action.id
              return (
                <QuickActionItem
                  key={action.id}
                  action={action}
                  isEditing={isEditing}
                  editingAction={editingAction}
                  setEditingAction={setEditingAction}
                  setIsAddingAction={setIsAddingAction}
                  handleDuplicateAction={handleDuplicateAction}
                  handleDeleteAction={handleDeleteAction}
                  handleSaveAction={handleSaveAction}
                  actionModeOptions={actionModeOptions}
                  actionRewriteTypeOptions={actionRewriteTypeOptions}
                  getInstructionDesc={getInstructionDesc}
                  getInstructionPlaceholder={getInstructionPlaceholder}
                  canSaveAction={canSaveAction}
                  t={t}
                />
              )
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

type QuickActionItemProps = {
  action: SelectionChatAction
  isEditing: boolean
  editingAction: SelectionChatAction | null
  setEditingAction: React.Dispatch<
    React.SetStateAction<SelectionChatAction | null>
  >
  setIsAddingAction: React.Dispatch<React.SetStateAction<boolean>>
  handleDuplicateAction: (action: SelectionChatAction) => void | Promise<void>
  handleDeleteAction: (id: string) => void | Promise<void>
  handleSaveAction: () => void | Promise<void>
  actionModeOptions: Record<SelectionChatActionMode, string>
  actionRewriteTypeOptions: Record<SelectionChatActionRewriteBehavior, string>
  getInstructionDesc: (mode: SelectionChatActionMode) => string
  getInstructionPlaceholder: (mode: SelectionChatActionMode) => string
  canSaveAction: (action: SelectionChatAction | null) => boolean
  t: TranslateFn
}

function QuickActionItem({
  action,
  isEditing,
  editingAction,
  setEditingAction,
  setIsAddingAction,
  handleDuplicateAction,
  handleDeleteAction,
  handleSaveAction,
  actionModeOptions,
  actionRewriteTypeOptions,
  getInstructionDesc,
  getInstructionPlaceholder,
  canSaveAction,
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
            aria-label={t('settings.selectionChat.dragHandleAria', '拖拽排序')}
            {...listeners}
          >
            <GripVertical size={16} />
          </span>
        </div>
        <div className="smtcmp-quick-action-content">
          <div className="smtcmp-quick-action-header">
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
            tooltip={t('settings.selectionChat.duplicate', '复制')}
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
            name={t('settings.selectionChat.actionLabel', '选项名称')}
            desc={t(
              'settings.selectionChat.actionLabelDesc',
              '显示在快捷选项中的文本',
            )}
          >
            <ObsidianTextInput
              value={currentEditing.label}
              placeholder={t(
                'settings.selectionChat.actionLabelPlaceholder',
                '例如：深入解释',
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
            name={t('settings.selectionChat.actionMode', '执行方式')}
            desc={t(
              'settings.selectionChat.actionModeDesc',
              '问答会打开 Quick Ask 并自动发送；改写会打开 Quick Ask 的编辑模式生成预览。',
            )}
          >
            <ObsidianDropdown
              value={currentEditing.mode ?? 'ask'}
              options={actionModeOptions}
              onChange={(value) =>
                setEditingAction({
                  ...currentEditing,
                  mode: value === 'rewrite' ? 'rewrite' : 'ask',
                  rewriteBehavior:
                    value === 'rewrite'
                      ? (currentEditing.rewriteBehavior ?? 'preset')
                      : currentEditing.rewriteBehavior,
                })
              }
            />
          </ObsidianSetting>

          {(currentEditing.mode ?? 'ask') === 'rewrite' && (
            <ObsidianSetting
              name={t('settings.selectionChat.actionRewriteType', '改写类型')}
              desc={t(
                'settings.selectionChat.actionRewriteTypeDesc',
                '选择改写是否需要输入指令',
              )}
            >
              <ObsidianDropdown
                value={currentEditing.rewriteBehavior ?? 'preset'}
                options={actionRewriteTypeOptions}
                onChange={(value) =>
                  setEditingAction({
                    ...currentEditing,
                    rewriteBehavior: value === 'custom' ? 'custom' : 'preset',
                  })
                }
              />
            </ObsidianSetting>
          )}

          <ObsidianSetting
            name={t('settings.selectionChat.actionInstruction', '提示词')}
            desc={getInstructionDesc(currentEditing.mode ?? 'ask')}
            className="smtcmp-settings-textarea-header"
          />
          <ObsidianSetting className="smtcmp-settings-textarea">
            <ObsidianTextArea
              value={currentEditing.instruction}
              placeholder={getInstructionPlaceholder(
                currentEditing.mode ?? 'ask',
              )}
              onChange={(value) =>
                setEditingAction({
                  ...currentEditing,
                  instruction: value,
                })
              }
            />
          </ObsidianSetting>

          <div className="smtcmp-quick-action-editor-buttons">
            <ObsidianButton
              text={t('common.save', '保存')}
              onClick={() => void handleSaveAction()}
              cta
              disabled={!canSaveAction(currentEditing)}
            />
            <ObsidianButton
              text={t('common.cancel', '取消')}
              onClick={() => setEditingAction(null)}
            />
          </div>
        </div>
      )}
    </>
  )
}
