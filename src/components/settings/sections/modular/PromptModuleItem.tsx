import React, { useState } from 'react'
import { App } from 'obsidian'
import {
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Edit, Trash2, GripVertical } from 'lucide-react'

import { ObsidianToggle } from '../../../common/ObsidianToggle'
import { ObsidianTextInput } from '../../../common/ObsidianTextInput'
import { useLanguage } from '../../../../contexts/language-context'
import { usePlugin } from '../../../../contexts/plugin-context'
import { PromptModule } from '../../../../settings/schema/setting.types'

import { PromptEditModal } from './PromptEditModal'

interface PromptModuleItemProps {
  prompt: PromptModule
  groupId: string
  onUpdatePrompt: (promptId: string, updates: any) => void
  onDeletePrompt: (promptId: string) => void
  onTogglePrompt: (promptId: string, enabled: boolean) => void
  onDragEnd?: (event: any) => void
}

const PromptModuleItem: React.FC<PromptModuleItemProps> = ({
  prompt,
  groupId,
  onUpdatePrompt,
  onDeletePrompt,
  onTogglePrompt,
  onDragEnd,
}) => {
  const { t } = useLanguage()
  const plugin = usePlugin()
  const [isEditingName, setIsEditingName] = useState(false)
  const [tempName, setTempName] = useState(prompt.name)
  const [isEditingContent, setIsEditingContent] = useState(false)

  // 拖拽排序hooks
  console.log('PromptModuleItem: rendering prompt:', prompt.id, 'name:', prompt.name, 'groupId:', groupId)
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: prompt.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  // 提示词名称编辑
  const handleNameEdit = () => {
    setIsEditingName(true)
    setTempName(prompt.name)
  }

  const handleNameSave = () => {
    if (tempName.trim() && tempName !== prompt.name) {
      onUpdatePrompt(prompt.id, { name: tempName.trim() })
    }
    setIsEditingName(false)
  }

  const handleNameCancel = () => {
    setTempName(prompt.name)
    setIsEditingName(false)
  }

  const handleNameKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleNameSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleNameCancel()
    }
  }

  const handleNameBlur = () => {
    handleNameSave()
  }

  // 提示词内容编辑
  const handleContentEdit = () => {
    new PromptEditModal(plugin.app, plugin, prompt, (content: string) => {
      onUpdatePrompt(prompt.id, { content })
    }).open()
  }

  // 拖拽结束处理
  const handleDragEnd = (event: any) => {
    if (onDragEnd) {
      onDragEnd(event)
    }
  }

  // 提示词删除
  const handleDelete = () => {
    const confirmMessage = t('settings.systemPrompt.confirmDeletePrompt') ||
      '确定要删除此提示词吗？'

    if (confirm(confirmMessage)) {
      onDeletePrompt(prompt.id)
    }
  }

  // 提示词启用/禁用
  const handleToggle = (enabled: boolean) => {
    onTogglePrompt(prompt.id, enabled)
  }

  return (
    <tr
      ref={setNodeRef}
      style={style}
      className={isDragging ? 'smtcmp-row-dragging' : ''}
      data-prompt-id={prompt.id}
      {...attributes}
    >
      <td>
        <span
          className="smtcmp-drag-handle"
          aria-label={t('settings.models.dragHandle', 'Drag to reorder')}
          {...listeners}
        >
          <GripVertical />
        </span>
      </td>
      <td title={prompt.name}>
        {isEditingName ? (
          <ObsidianTextInput
            value={tempName}
            onChange={setTempName}
            placeholder={t('settings.systemPrompt.promptNamePlaceholder') || '提示词名称'}
            onKeyDown={handleNameKeyDown}
            onBlur={handleNameBlur}
          />
        ) : (
          <span
            onClick={handleNameEdit}
            title={t('settings.systemPrompt.editPromptName') || '点击编辑提示词名称'}
            style={{ cursor: 'pointer' }}
          >
            {prompt.name}
          </span>
        )}
      </td>
      <td onPointerDown={(event) => event.stopPropagation()}>
        <ObsidianToggle
          value={prompt.enabled}
          onChange={handleToggle}
        />
      </td>
      <td>
        <div className="smtcmp-settings-actions">
          <button
            onClick={() => handleContentEdit()}
            className="clickable-icon"
            title={t('settings.systemPrompt.editPrompt') || '编辑提示词'}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Edit />
          </button>
          <button
            onClick={() => handleDelete()}
            className="clickable-icon"
            title={t('settings.systemPrompt.deletePrompt') || '删除提示词'}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Trash2 />
          </button>
        </div>
      </td>
    </tr>
  )
}

export default PromptModuleItem