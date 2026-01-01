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
import { App } from 'obsidian'
import React, { type FC, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { Assistant, AssistantIcon } from '../../../types/assistant.types'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { openIconPicker } from '../assistants/AssistantIconPicker'
import { AssistantsModal } from '../modals/AssistantsModal'

type AssistantsSectionProps = {
  app: App
}

type Translator = ReturnType<typeof useLanguage>['t']

type AssistantListItemProps = {
  app: App
  assistant: Assistant
  isEditing: boolean
  editingAssistant: Assistant | null
  setEditingAssistant: React.Dispatch<React.SetStateAction<Assistant | null>>
  setIsAddingAssistant: React.Dispatch<React.SetStateAction<boolean>>
  handleDuplicateAssistant: (assistant: Assistant) => void | Promise<void>
  handleDeleteAssistant: (id: string) => void
  handleSaveAssistant: () => void | Promise<void>
  handleUpdateIcon: (
    assistantId: string,
    newIcon: AssistantIcon,
  ) => void | Promise<void>
  t: Translator
}

export const AssistantsSection: FC<AssistantsSectionProps> = ({ app }) => {
  const plugin = usePlugin()
  const { settings } = useSettings()
  const { t } = useLanguage()
  const assistants = settings.assistants || []
  const assistantsCountLabel = t(
    'settings.assistants.assistantsCount',
    '已配置 {count} 个助手',
  ).replace('{count}', String(assistants.length))

  return (
    <div className="smtcmp-settings-section">
      <ObsidianSetting
        name={t('settings.assistants.title')}
        desc={t('settings.assistants.desc')}
      >
        <div className="smtcmp-settings-desc">{assistantsCountLabel}</div>
        <ObsidianButton
          text={t('settings.assistants.configureAssistants', '配置助手')}
          onClick={() => {
            const modal = new AssistantsModal(app, plugin)
            modal.open()
          }}
        />
      </ObsidianSetting>
    </div>
  )
}

export const AssistantsSectionContent: FC<AssistantsSectionProps> = ({
  app,
}) => {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const assistants = settings.assistants || []
  const [editingAssistant, setEditingAssistant] = useState<Assistant | null>(
    null,
  )
  const [isAddingAssistant, setIsAddingAssistant] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
  )
  const assistantIds = assistants.map((assistant) => assistant.id)

  const handleSaveAssistants = async (newAssistants: Assistant[]) => {
    await setSettings({
      ...settings,
      assistants: newAssistants,
    })
  }

  const handleAddAssistant = () => {
    const newAssistant: Assistant = {
      id: crypto.randomUUID(),
      name: '',
      description: '',
      systemPrompt: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    setEditingAssistant(newAssistant)
    setIsAddingAssistant(true)
  }

  const handleSaveAssistant = async () => {
    if (
      !editingAssistant ||
      !editingAssistant.name ||
      !editingAssistant.systemPrompt
    ) {
      return
    }

    let newAssistants: Assistant[]
    if (isAddingAssistant) {
      newAssistants = [
        ...assistants,
        { ...editingAssistant, updatedAt: Date.now() },
      ]
    } else {
      newAssistants = assistants.map((a) =>
        a.id === editingAssistant.id
          ? { ...editingAssistant, updatedAt: Date.now() }
          : a,
      )
    }

    try {
      await handleSaveAssistants(newAssistants)
      setEditingAssistant(null)
      setIsAddingAssistant(false)
    } catch (error: unknown) {
      console.error('Failed to save assistant', error)
    }
  }

  const handleUpdateIcon = async (
    assistantId: string,
    newIcon: AssistantIcon,
  ) => {
    const newAssistants = assistants.map((a) =>
      a.id === assistantId ? { ...a, icon: newIcon, updatedAt: Date.now() } : a,
    )

    try {
      await handleSaveAssistants(newAssistants)
      // 同时更新编辑中的助手状态
      if (editingAssistant && editingAssistant.id === assistantId) {
        setEditingAssistant({ ...editingAssistant, icon: newIcon })
      }
    } catch (error: unknown) {
      console.error('Failed to update icon', error)
    }
  }

  const handleDeleteAssistant = (id: string) => {
    const assistantToDelete = assistants.find((a) => a.id === id)
    if (!assistantToDelete) return

    let confirmed = false

    const modal = new ConfirmModal(app, {
      title: t(
        'settings.assistants.deleteConfirmTitle',
        'Confirm delete assistant',
      ),
      message: `${t('settings.assistants.deleteConfirmMessagePrefix', 'Are you sure you want to delete assistant')} "${assistantToDelete.name}"${t('settings.assistants.deleteConfirmMessageSuffix', '? This action cannot be undone.')}`,
      ctaText: t('common.delete'),
      onConfirm: () => {
        confirmed = true
      },
    })

    modal.onClose = () => {
      if (!confirmed) return

      void (async () => {
        try {
          const updatedAssistants = assistants.filter((a) => a.id !== id)

          let newCurrentAssistantId = settings.currentAssistantId
          if (id === settings.currentAssistantId) {
            newCurrentAssistantId =
              updatedAssistants.length > 0 ? updatedAssistants[0].id : undefined
          }

          await setSettings({
            ...settings,
            assistants: updatedAssistants,
            currentAssistantId: newCurrentAssistantId,
          })
        } catch (error: unknown) {
          console.error('Failed to delete assistant', error)
        }
      })()
    }

    modal.open()
  }

  const handleDuplicateAssistant = async (assistant: Assistant) => {
    const newAssistant: Assistant = {
      ...assistant,
      id: crypto.randomUUID(),
      name: `${assistant.name}${t('settings.assistants.copySuffix', ' (副本)')}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const newAssistants = [...assistants, newAssistant]
    try {
      await handleSaveAssistants(newAssistants)
    } catch (error: unknown) {
      console.error('Failed to duplicate assistant', error)
    }
  }

  const triggerDropSuccess = (movedId: string) => {
    const tryFind = (attempt = 0) => {
      const movedItem = document.querySelector(
        `div[data-assistant-id="${movedId}"]`,
      )
      if (movedItem) {
        movedItem.classList.add('smtcmp-assistant-item-drop-success')
        window.setTimeout(() => {
          movedItem.classList.remove('smtcmp-assistant-item-drop-success')
        }, 700)
      } else if (attempt < 8) {
        window.setTimeout(() => tryFind(attempt + 1), 50)
      }
    }
    requestAnimationFrame(() => tryFind())
  }

  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) {
      return
    }

    const oldIndex = assistants.findIndex((a) => a.id === active.id)
    const newIndex = assistants.findIndex((a) => a.id === over.id)
    if (oldIndex < 0 || newIndex < 0) {
      return
    }

    const reorderedAssistants = arrayMove(assistants, oldIndex, newIndex)
    reorderedAssistants[newIndex] = {
      ...reorderedAssistants[newIndex],
      updatedAt: Date.now(),
    }

    try {
      await handleSaveAssistants(reorderedAssistants)
      triggerDropSuccess(String(active.id))
    } catch (error: unknown) {
      console.error('Failed to reorder assistants', error)
    }
  }

  return (
    <div className="smtcmp-settings-section">
      <ObsidianSetting
        name={t('settings.assistants.title')}
        desc={t('settings.assistants.desc')}
      >
        <ObsidianButton
          text={t('settings.assistants.addAssistant')}
          onClick={handleAddAssistant}
        />
      </ObsidianSetting>

      {/* Add new assistant form */}
      {isAddingAssistant && editingAssistant && (
        <div className="smtcmp-assistant-editor smtcmp-assistant-editor-new">
          <ObsidianSetting
            name={t('settings.assistants.name', 'Name')}
            desc={t('settings.assistants.nameDesc', 'Assistant name')}
          >
            <ObsidianTextInput
              value={editingAssistant.name}
              placeholder={t(
                'settings.assistants.namePlaceholder',
                'Enter assistant name',
              )}
              onChange={(value) =>
                setEditingAssistant({ ...editingAssistant, name: value })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.assistants.description', 'Description')}
            desc={t(
              'settings.assistants.descriptionDesc',
              'Brief description of what this assistant does',
            )}
          >
            <ObsidianTextInput
              value={editingAssistant.description || ''}
              placeholder={t(
                'settings.assistants.descriptionPlaceholder',
                'Enter description',
              )}
              onChange={(value) =>
                setEditingAssistant({ ...editingAssistant, description: value })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.assistants.icon', '图标')}
            desc={t('settings.assistants.iconDesc', '选择助手图标')}
          >
            <ObsidianButton
              text={t('settings.assistants.chooseIcon', '选择图标')}
              onClick={() => {
                openIconPicker(app, editingAssistant.icon, (newIcon) => {
                  setEditingAssistant({ ...editingAssistant, icon: newIcon })
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.assistants.systemPrompt', 'System prompt')}
            desc={t(
              'settings.assistants.systemPromptDesc',
              'This prompt will be added to the beginning of every chat.',
            )}
            className="smtcmp-settings-textarea-header"
          />
          <ObsidianSetting className="smtcmp-settings-textarea">
            <ObsidianTextArea
              value={editingAssistant.systemPrompt || ''}
              onChange={(value) =>
                setEditingAssistant({
                  ...editingAssistant,
                  systemPrompt: value,
                })
              }
              placeholder={t(
                'settings.assistants.systemPromptPlaceholder',
                "Enter system prompt to define assistant's behavior and capabilities",
              )}
            />
          </ObsidianSetting>

          <div className="smtcmp-assistant-editor-buttons">
            <ObsidianButton
              text={t('common.save', 'Save')}
              onClick={() => void handleSaveAssistant()}
              cta
              disabled={
                !editingAssistant.name || !editingAssistant.systemPrompt
              }
            />
            <ObsidianButton
              text={t('common.cancel', 'Cancel')}
              onClick={() => {
                setEditingAssistant(null)
                setIsAddingAssistant(false)
              }}
            />
          </div>
        </div>
      )}

      {assistants.length === 0 ? (
        <div className="smtcmp-no-assistants">
          <p className="smtcmp-no-assistants-text">
            {t('settings.assistants.noAssistants')}
          </p>
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(event) => void handleDragEnd(event)}
        >
          <SortableContext
            items={assistantIds}
            strategy={verticalListSortingStrategy}
          >
            <div className="smtcmp-assistants-list">
              {assistants.map((assistant) => {
                const isEditing =
                  !isAddingAssistant && editingAssistant?.id === assistant.id

                return (
                  <AssistantListItem
                    key={assistant.id}
                    app={app}
                    assistant={assistant}
                    isEditing={isEditing}
                    editingAssistant={editingAssistant}
                    setEditingAssistant={setEditingAssistant}
                    setIsAddingAssistant={setIsAddingAssistant}
                    handleDuplicateAssistant={handleDuplicateAssistant}
                    handleDeleteAssistant={handleDeleteAssistant}
                    handleSaveAssistant={handleSaveAssistant}
                    handleUpdateIcon={handleUpdateIcon}
                    t={t}
                  />
                )
              })}
            </div>
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

const AssistantListItem: FC<AssistantListItemProps> = ({
  app,
  assistant,
  isEditing,
  editingAssistant,
  setEditingAssistant,
  setIsAddingAssistant,
  handleDuplicateAssistant,
  handleDeleteAssistant,
  handleSaveAssistant,
  handleUpdateIcon,
  t,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: assistant.id, disabled: isEditing })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  const currentEditing = isEditing ? editingAssistant : null

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        data-assistant-id={assistant.id}
        className={`smtcmp-assistant-item ${isEditing ? 'editing' : ''} ${isDragging ? 'smtcmp-assistant-item-dragging' : ''}`}
        {...attributes}
      >
        <div className="smtcmp-assistant-drag-handle">
          <span
            className={`smtcmp-drag-handle ${isDragging ? 'smtcmp-drag-handle--active' : ''}`}
            aria-label={t(
              'settings.assistants.dragHandleAria',
              'Drag to reorder',
            )}
            {...listeners}
          >
            <GripVertical size={16} />
          </span>
        </div>
        <div className="smtcmp-assistant-content">
          <div className="smtcmp-assistant-header">
            <div className="smtcmp-assistant-icon">
              {renderAssistantIcon(assistant.icon, 16)}
            </div>
            <div className="smtcmp-assistant-info">
              <div className="smtcmp-assistant-name">{assistant.name}</div>
              {assistant.description && (
                <div className="smtcmp-assistant-description">
                  {assistant.description}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="smtcmp-assistant-controls">
          <ObsidianButton
            onClick={() => {
              if (isEditing) {
                setEditingAssistant(null)
              } else {
                setEditingAssistant(assistant)
                setIsAddingAssistant(false)
              }
            }}
            icon={isEditing ? 'x' : 'pencil'}
            tooltip={
              isEditing
                ? t('common.cancel', 'Cancel')
                : t('common.edit', 'Edit')
            }
          />
          <ObsidianButton
            onClick={() => void handleDuplicateAssistant(assistant)}
            icon="copy"
            tooltip={t('settings.assistants.duplicate', 'Duplicate')}
          />
          <ObsidianButton
            onClick={() => handleDeleteAssistant(assistant.id)}
            icon="trash-2"
            tooltip={t('common.delete', 'Delete')}
          />
        </div>
      </div>

      {isEditing && currentEditing && (
        <div className="smtcmp-assistant-editor smtcmp-assistant-editor-inline">
          <ObsidianSetting
            name={t('settings.assistants.name', 'Name')}
            desc={t('settings.assistants.nameDesc', 'Assistant name')}
          >
            <ObsidianTextInput
              value={currentEditing.name}
              placeholder={t(
                'settings.assistants.namePlaceholder',
                'Enter assistant name',
              )}
              onChange={(value) =>
                setEditingAssistant({
                  ...currentEditing,
                  name: value,
                })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.assistants.description', 'Description')}
            desc={t(
              'settings.assistants.descriptionDesc',
              'Brief description of what this assistant does',
            )}
          >
            <ObsidianTextInput
              value={currentEditing.description || ''}
              placeholder={t(
                'settings.assistants.descriptionPlaceholder',
                'Enter description',
              )}
              onChange={(value) =>
                setEditingAssistant({
                  ...currentEditing,
                  description: value,
                })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.assistants.icon', '图标')}
            desc={t('settings.assistants.iconDesc', '选择助手图标')}
          >
            <ObsidianButton
              text={t('settings.assistants.chooseIcon', '选择图标')}
              onClick={() => {
                openIconPicker(app, currentEditing.icon, (newIcon) => {
                  // 立即保存图标到数据库
                  void handleUpdateIcon(assistant.id, newIcon)
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.assistants.systemPrompt', 'System prompt')}
            desc={t(
              'settings.assistants.systemPromptDesc',
              'This prompt will be added to the beginning of every chat.',
            )}
            className="smtcmp-settings-textarea-header"
          />
          <ObsidianSetting className="smtcmp-settings-textarea">
            <ObsidianTextArea
              value={currentEditing.systemPrompt || ''}
              onChange={(value) =>
                setEditingAssistant({
                  ...currentEditing,
                  systemPrompt: value,
                })
              }
              placeholder={t(
                'settings.assistants.systemPromptPlaceholder',
                "Enter system prompt to define assistant's behavior and capabilities",
              )}
            />
          </ObsidianSetting>

          <div className="smtcmp-assistant-editor-buttons">
            <ObsidianButton
              text={t('common.save', 'Save')}
              onClick={() => void handleSaveAssistant()}
              cta
              disabled={!currentEditing.name || !currentEditing.systemPrompt}
            />
            <ObsidianButton
              text={t('common.cancel', 'Cancel')}
              onClick={() => {
                setEditingAssistant(null)
              }}
            />
          </div>
        </div>
      )}
    </>
  )
}
