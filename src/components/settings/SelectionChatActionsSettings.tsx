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
import { SelectionChatActionsModal } from './modals/SelectionChatActionsModal'

type SelectionChatAction = {
  id: string
  label: string
  instruction: string
  enabled: boolean
  mode?: SelectionChatActionMode
  rewriteBehavior?: SelectionChatActionRewriteBehavior
  assistantId?: string
}

// Sentinel for the "follow current selection" option in the assistant dropdown.
// Maps to `assistantId === undefined` when persisted.
const FOLLOW_CURRENT_ASSISTANT_VALUE = '__follow_current__'

type SelectionChatActionMode = 'ask' | 'rewrite' | 'chat-input' | 'chat-send'
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

// Fixed actions are built-in entries that always exist; users can reorder and
// hide them but cannot edit their label/instruction. They live in the same
// `selectionChatActions` array as a sortable placeholder.
const FIXED_ACTION_CONFIGS: DefaultActionConfig[] = [
  {
    id: 'custom-rewrite',
    labelKey: 'selection.actions.customRewrite',
    labelFallback: '自定义改写',
    mode: 'rewrite',
    rewriteBehavior: 'custom',
    allowEmptyInstruction: true,
  },
  {
    id: 'custom-ask',
    labelKey: 'selection.actions.customAsk',
    labelFallback: '自定义提问',
    mode: 'ask',
    allowEmptyInstruction: true,
  },
  {
    id: 'add-to-sidebar',
    labelKey: 'selection.actions.addToSidebar',
    labelFallback: '添加到侧边栏',
    mode: 'chat-input',
    allowEmptyInstruction: true,
  },
]

const FIXED_ACTION_IDS = new Set(FIXED_ACTION_CONFIGS.map((c) => c.id))

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

const ALL_KNOWN_ACTION_LOOKUP: Record<string, DefaultActionConfig> =
  Object.fromEntries(
    [...FIXED_ACTION_CONFIGS, ...DEFAULT_ACTION_CONFIGS].map((c) => [c.id, c]),
  )

const resolveSelectionActionMode = (
  action: SelectionChatAction,
): SelectionChatActionMode => {
  if (action.mode) return action.mode
  if (action.id === 'rewrite' || action.id === 'custom-rewrite') {
    return 'rewrite'
  }
  if (action.id === 'chat-send') {
    return 'chat-send'
  }
  if (action.id === 'chat-input' || action.id === 'add-to-sidebar') {
    return 'chat-input'
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

const normalizeActionMode = (value: string): SelectionChatActionMode => {
  if (value === 'rewrite') return 'rewrite'
  if (value === 'chat-input') return 'chat-input'
  if (value === 'chat-send') return 'chat-send'
  return 'ask'
}

const generateId = () => {
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
}

const getDefaultSelectionChatActions = (
  t: TranslateFn,
): SelectionChatAction[] => {
  return [...FIXED_ACTION_CONFIGS, ...DEFAULT_ACTION_CONFIGS].map((config) => {
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

/**
 * Ensure the user's stored actions include all fixed actions. Missing fixed
 * actions are prepended in canonical order with `enabled: true`. Returns the
 * synthesised list along with a flag indicating whether anything was added.
 */
const withFixedActionsBackfilled = (
  actions: SelectionChatAction[],
  t: TranslateFn,
): { list: SelectionChatAction[]; backfilled: boolean } => {
  // Defensive dedup: collapse any duplicate fixed-action ids (from dirty legacy
  // data) to the first occurrence so hide/show and reorder behave predictably.
  const seenFixed = new Set<string>()
  const deduped = actions.filter((a) => {
    if (!FIXED_ACTION_IDS.has(a.id)) return true
    if (seenFixed.has(a.id)) return false
    seenFixed.add(a.id)
    return true
  })
  const dedupedChanged = deduped.length !== actions.length

  const presentIds = new Set(deduped.map((a) => a.id))
  const missingConfigs = FIXED_ACTION_CONFIGS.filter(
    (c) => !presentIds.has(c.id),
  )
  if (missingConfigs.length === 0) {
    return { list: deduped, backfilled: dedupedChanged }
  }
  const missing = missingConfigs.map((config) => {
    const label = t(config.labelKey, config.labelFallback)
    return {
      id: config.id,
      label,
      instruction: '',
      enabled: true,
      mode: config.mode ?? 'ask',
      rewriteBehavior: config.rewriteBehavior,
    }
  })
  return { list: [...missing, ...deduped], backfilled: true }
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
    '已配置 {count} 个快捷指令',
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
      <div className="yolo-smart-space-settings">
        <div className="yolo-smart-space-settings-row">
          <div className="yolo-settings-desc">{actionsCountLabel}</div>
          <ObsidianButton
            text={t('settings.selectionChat.configureActions', '配置快捷指令')}
            onClick={handleOpenModal}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="yolo-smart-space-settings">
      <ObsidianSetting
        name={t(
          'settings.selectionChat.quickActionsTitle',
          'Cursor Chat 快捷指令',
        )}
        desc={t(
          'settings.selectionChat.quickActionsDesc',
          '自定义选中文本后显示的快捷指令和提示词',
        )}
        className="yolo-settings-card"
      >
        <div className="yolo-settings-desc">{actionsCountLabel}</div>
        <ObsidianButton
          text={t('settings.selectionChat.configureActions', '配置快捷指令')}
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
    ask: t('settings.selectionChat.actionModeAsk', 'Quick Ask 问答'),
    rewrite: t('settings.selectionChat.actionModeRewrite', 'Quick Ask 改写'),
    'chat-input': t(
      'settings.selectionChat.actionModeChatInput',
      '添加到对话框',
    ),
    'chat-send': t(
      'settings.selectionChat.actionModeChatSend',
      '添加到对话框并发送',
    ),
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
  const assistantOptions = useMemo<Record<string, string>>(() => {
    const followCurrentLabel = t(
      'settings.selectionChat.actionAssistantFollowCurrent',
      '跟随当前选择',
    )
    const options: Record<string, string> = {
      [FOLLOW_CURRENT_ASSISTANT_VALUE]: followCurrentLabel,
    }
    for (const assistant of settings.assistants ?? []) {
      options[assistant.id] = assistant.name || assistant.id
    }
    return options
  }, [settings.assistants, t])
  const resolveAssistantDropdownValue = (value?: string) =>
    value && assistantOptions[value] ? value : FOLLOW_CURRENT_ASSISTANT_VALUE
  const normalizeAssistantDropdownValue = (value: string) =>
    value === FOLLOW_CURRENT_ASSISTANT_VALUE ? undefined : value
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )

  const rawActions =
    settings.continuationOptions.selectionChatActions ||
    getDefaultSelectionChatActions(t)
  const { list: backfilledActions } = withFixedActionsBackfilled(rawActions, t)
  const selectionChatActions = backfilledActions.map((action) => {
    const isFixed = FIXED_ACTION_IDS.has(action.id)
    const config = ALL_KNOWN_ACTION_LOOKUP[action.id]
    let label = action.label
    let instruction = action.instruction
    const mode = isFixed
      ? (config?.mode ?? resolveSelectionActionMode(action))
      : resolveSelectionActionMode(action)
    const rewriteBehavior = isFixed
      ? config?.rewriteBehavior
      : resolveRewriteBehavior(action, mode)

    if (config) {
      const localizedLabel = t(config.labelKey, config.labelFallback)
      if (
        isFixed ||
        label === config.labelFallback ||
        label === localizedLabel ||
        !label
      ) {
        label = localizedLabel
      }
      if (
        !isFixed &&
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
      // Fixed actions preserve user's enabled choice (hide/show toggle);
      // editable actions are always enabled in storage.
      enabled: isFixed ? (action.enabled ?? true) : true,
      mode,
      rewriteBehavior,
    }
  })

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

  const actionIds = selectionChatActions.map((action) => action.id)

  // Persist a full action list. Fixed actions keep their stored enabled state
  // (hidden when false); editable actions are always enabled.
  const handleSaveActions = async (newActions: SelectionChatAction[]) => {
    await setSettings({
      ...settings,
      continuationOptions: {
        ...settings.continuationOptions,
        selectionChatActions: newActions.map((action) => ({
          ...action,
          enabled: FIXED_ACTION_IDS.has(action.id)
            ? (action.enabled ?? true)
            : true,
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
      newActions = [
        ...selectionChatActions,
        { ...editingAction, enabled: true },
      ]
    } else {
      newActions = selectionChatActions.map((action) =>
        action.id === editingAction.id
          ? { ...editingAction, enabled: true }
          : action,
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
    // Editable actions are removed; fixed actions can't reach this path.
    const newActions = selectionChatActions.filter((action) => action.id !== id)
    try {
      await handleSaveActions(newActions)
    } catch (error: unknown) {
      console.error('Failed to delete Cursor Chat quick action', error)
    }
  }

  const handleToggleFixedAction = async (id: string) => {
    const newActions = selectionChatActions.map((action) =>
      action.id === id
        ? { ...action, enabled: !(action.enabled ?? true) }
        : action,
    )
    try {
      await handleSaveActions(newActions)
    } catch (error: unknown) {
      console.error('Failed to toggle Cursor Chat fixed action', error)
    }
  }

  const handleDuplicateAction = async (action: SelectionChatAction) => {
    const newAction = {
      ...action,
      id: generateId(),
      label: `${action.label}${t('settings.selectionChat.copySuffix', ' (副本)')}`,
      enabled: true,
    }
    const newActions = [...selectionChatActions, newAction]
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
        movedItem.classList.add('yolo-quick-action-drop-success')
        window.setTimeout(() => {
          movedItem.classList.remove('yolo-quick-action-drop-success')
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

    const oldIndex = selectionChatActions.findIndex(
      (action) => action.id === active.id,
    )
    const newIndex = selectionChatActions.findIndex(
      (action) => action.id === over.id,
    )
    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    const reorderedActions = arrayMove(selectionChatActions, oldIndex, newIndex)

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
        '确定要恢复默认的快捷指令吗？这将删除所有自定义设置。',
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
    <div className="yolo-smart-space-settings">
      <ObsidianSetting
        name={t(
          'settings.selectionChat.quickActionsTitle',
          'Cursor Chat 快捷指令',
        )}
        desc={t(
          'settings.selectionChat.quickActionsDesc',
          '自定义选中文本后显示的快捷指令和提示词',
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
        <div className="yolo-quick-action-editor yolo-quick-action-editor-new">
          <ObsidianSetting
            name={t('settings.selectionChat.actionLabel', '选项名称')}
            desc={t(
              'settings.selectionChat.actionLabelDesc',
              '显示在快捷指令中的文本',
            )}
          >
            <ObsidianTextInput
              value={editingAction.label}
              placeholder={t(
                'settings.selectionChat.actionLabelPlaceholder',
                '例如：深入解释',
              )}
              onChange={(value) =>
                setEditingAction((prev) =>
                  prev
                    ? {
                        ...prev,
                        label: value,
                      }
                    : prev,
                )
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.selectionChat.actionMode', '执行方式')}
            desc={t(
              'settings.selectionChat.actionModeDesc',
              '前两项调用 Quick Ask：问答会自动发送，改写会进入预览模式；后两项调用 Chat：可选择仅填入对话框，或直接发送。',
            )}
          >
            <ObsidianDropdown
              value={editingAction.mode ?? 'ask'}
              options={actionModeOptions}
              onChange={(value) =>
                setEditingAction((prev) =>
                  prev
                    ? {
                        ...prev,
                        mode: normalizeActionMode(value),
                        rewriteBehavior:
                          value === 'rewrite'
                            ? (prev.rewriteBehavior ?? 'preset')
                            : prev.rewriteBehavior,
                      }
                    : prev,
                )
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
                  setEditingAction((prev) =>
                    prev
                      ? {
                          ...prev,
                          rewriteBehavior:
                            value === 'custom' ? 'custom' : 'preset',
                        }
                      : prev,
                  )
                }
              />
            </ObsidianSetting>
          )}

          <ObsidianSetting
            name={t('settings.selectionChat.actionAssistant', '使用助手')}
            desc={t(
              'settings.selectionChat.actionAssistantDesc',
              '运行此指令时使用的助手；留空则跟随当前选择。',
            )}
          >
            <ObsidianDropdown
              value={resolveAssistantDropdownValue(editingAction.assistantId)}
              options={assistantOptions}
              onChange={(value) =>
                setEditingAction((prev) =>
                  prev
                    ? {
                        ...prev,
                        assistantId: normalizeAssistantDropdownValue(value),
                      }
                    : prev,
                )
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.selectionChat.actionInstruction', '提示词')}
            desc={getInstructionDesc(editingAction.mode ?? 'ask')}
            className="yolo-settings-textarea-header"
          />
          <ObsidianSetting className="yolo-settings-textarea">
            <ObsidianTextArea
              value={editingAction.instruction}
              placeholder={getInstructionPlaceholder(
                editingAction.mode ?? 'ask',
              )}
              onChange={(value) =>
                setEditingAction((prev) =>
                  prev
                    ? {
                        ...prev,
                        instruction: value,
                      }
                    : prev,
                )
              }
            />
          </ObsidianSetting>

          <div className="yolo-quick-action-editor-buttons">
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
          <div className="yolo-quick-actions-list">
            {selectionChatActions.map((action) => {
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
                  handleToggleFixedAction={handleToggleFixedAction}
                  handleSaveAction={handleSaveAction}
                  actionModeOptions={actionModeOptions}
                  actionRewriteTypeOptions={actionRewriteTypeOptions}
                  assistantOptions={assistantOptions}
                  resolveAssistantDropdownValue={resolveAssistantDropdownValue}
                  normalizeAssistantDropdownValue={
                    normalizeAssistantDropdownValue
                  }
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
  handleToggleFixedAction: (id: string) => void | Promise<void>
  handleSaveAction: () => void | Promise<void>
  actionModeOptions: Record<SelectionChatActionMode, string>
  actionRewriteTypeOptions: Record<SelectionChatActionRewriteBehavior, string>
  assistantOptions: Record<string, string>
  resolveAssistantDropdownValue: (value?: string) => string
  normalizeAssistantDropdownValue: (value: string) => string | undefined
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
  handleToggleFixedAction,
  handleSaveAction,
  actionModeOptions,
  actionRewriteTypeOptions,
  assistantOptions,
  resolveAssistantDropdownValue,
  normalizeAssistantDropdownValue,
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
  const isFixed = FIXED_ACTION_IDS.has(action.id)
  const isHidden = isFixed && action.enabled === false
  const itemClassName = [
    'yolo-quick-action-item',
    isEditing ? 'editing' : '',
    isDragging ? 'yolo-quick-action-dragging' : '',
    isFixed ? 'yolo-quick-action-item--fixed' : '',
    isHidden ? 'yolo-quick-action-item--hidden' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        data-action-id={action.id}
        className={itemClassName}
        {...attributes}
      >
        <div className="yolo-quick-action-drag-handle">
          <span
            className={`yolo-drag-handle ${isDragging ? 'yolo-drag-handle--active' : ''}`}
            aria-label={t('settings.selectionChat.dragHandleAria', '拖拽排序')}
            {...listeners}
          >
            <GripVertical size={16} />
          </span>
        </div>
        <div className="yolo-quick-action-content">
          <div className="yolo-quick-action-header">
            <span className="yolo-quick-action-label">{action.label}</span>
            {isFixed && (
              <span className="yolo-quick-action-fixed-hint">
                {t('settings.selectionChat.fixedActionHint', '内置指令')}
              </span>
            )}
          </div>
        </div>
        <div className="yolo-quick-action-controls">
          {isFixed ? (
            <ObsidianButton
              onClick={() => void handleToggleFixedAction(action.id)}
              icon={isHidden ? 'eye' : 'eye-off'}
              tooltip={
                isHidden
                  ? t(
                      'settings.selectionChat.showFixedAction',
                      '在 Cursor Chat 中显示',
                    )
                  : t(
                      'settings.selectionChat.hideFixedAction',
                      '在 Cursor Chat 中隐藏',
                    )
              }
            />
          ) : (
            <>
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
                  isEditing
                    ? t('common.cancel', '取消')
                    : t('common.edit', '编辑')
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
            </>
          )}
        </div>
      </div>

      {isEditing && currentEditing && (
        <div className="yolo-quick-action-editor yolo-quick-action-editor-inline">
          <ObsidianSetting
            name={t('settings.selectionChat.actionLabel', '选项名称')}
            desc={t(
              'settings.selectionChat.actionLabelDesc',
              '显示在快捷指令中的文本',
            )}
          >
            <ObsidianTextInput
              value={currentEditing.label}
              placeholder={t(
                'settings.selectionChat.actionLabelPlaceholder',
                '例如：深入解释',
              )}
              onChange={(value) =>
                setEditingAction((prev) =>
                  prev
                    ? {
                        ...prev,
                        label: value,
                      }
                    : prev,
                )
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.selectionChat.actionMode', '执行方式')}
            desc={t(
              'settings.selectionChat.actionModeDesc',
              '前两项调用 Quick Ask：问答会自动发送，改写会进入预览模式；后两项调用 Chat：可选择仅填入对话框，或直接发送。',
            )}
          >
            <ObsidianDropdown
              value={currentEditing.mode ?? 'ask'}
              options={actionModeOptions}
              onChange={(value) =>
                setEditingAction((prev) =>
                  prev
                    ? {
                        ...prev,
                        mode: normalizeActionMode(value),
                        rewriteBehavior:
                          value === 'rewrite'
                            ? (prev.rewriteBehavior ?? 'preset')
                            : prev.rewriteBehavior,
                      }
                    : prev,
                )
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
                  setEditingAction((prev) =>
                    prev
                      ? {
                          ...prev,
                          rewriteBehavior:
                            value === 'custom' ? 'custom' : 'preset',
                        }
                      : prev,
                  )
                }
              />
            </ObsidianSetting>
          )}

          <ObsidianSetting
            name={t('settings.selectionChat.actionAssistant', '使用助手')}
            desc={t(
              'settings.selectionChat.actionAssistantDesc',
              '运行此指令时使用的助手；留空则跟随当前选择。',
            )}
          >
            <ObsidianDropdown
              value={resolveAssistantDropdownValue(currentEditing.assistantId)}
              options={assistantOptions}
              onChange={(value) =>
                setEditingAction((prev) =>
                  prev
                    ? {
                        ...prev,
                        assistantId: normalizeAssistantDropdownValue(value),
                      }
                    : prev,
                )
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.selectionChat.actionInstruction', '提示词')}
            desc={getInstructionDesc(currentEditing.mode ?? 'ask')}
            className="yolo-settings-textarea-header"
          />
          <ObsidianSetting className="yolo-settings-textarea">
            <ObsidianTextArea
              value={currentEditing.instruction}
              placeholder={getInstructionPlaceholder(
                currentEditing.mode ?? 'ask',
              )}
              onChange={(value) =>
                setEditingAction((prev) =>
                  prev
                    ? {
                        ...prev,
                        instruction: value,
                      }
                    : prev,
                )
              }
            />
          </ObsidianSetting>

          <div className="yolo-quick-action-editor-buttons">
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
