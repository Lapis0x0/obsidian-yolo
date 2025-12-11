import React, { useState } from 'react'
import {
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ChevronDown, ChevronRight, Plus, Trash2, GripVertical, Edit, Settings } from 'lucide-react'

import { ObsidianSetting } from '../../../common/ObsidianSetting'
import { ObsidianToggle } from '../../../common/ObsidianToggle'
import { ObsidianTextInput } from '../../../common/ObsidianTextInput'
import { useLanguage } from '../../../../contexts/language-context'
import { SystemPromptGenerator } from '../../../../utils/systemPromptGenerator'
import { PromptGroup } from '../../../../settings/schema/setting.types'

import PromptModuleList from './PromptModuleList'
import PromptModuleItem from './PromptModuleItem'

interface PromptGroupItemProps {
  group: PromptGroup
  isExpanded: boolean
  onToggleExpanded: () => void
  onUpdateGroup: (updates: Partial<PromptGroup>) => void
  onDeleteGroup: () => void
  onToggleGroup: (enabled: boolean) => void
  onAddPrompt: () => void
  onUpdatePrompt: (promptId: string, updates: any) => void
  onDeletePrompt: (promptId: string) => void
  onTogglePrompt: (promptId: string, enabled: boolean) => void
  onPromptDragEnd: (groupId: string, event: any) => void
}

const PromptGroupItem: React.FC<PromptGroupItemProps> = ({
  group,
  isExpanded,
  onToggleExpanded,
  onUpdateGroup,
  onDeleteGroup,
  onToggleGroup,
  onAddPrompt,
  onUpdatePrompt,
  onDeletePrompt,
  onTogglePrompt,
  onPromptDragEnd,
}) => {
  console.log(`PromptGroupItem rendering: group.id=${group.id}, group.name=${group.name}, isExpanded=${isExpanded}`)
  const { t } = useLanguage()
  const [isEditingName, setIsEditingName] = useState(false)
  const [tempName, setTempName] = useState(group.name)

  // 拖拽排序hooks
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: group.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  // 分组名称编辑
  const handleNameEdit = () => {
    setIsEditingName(true)
    setTempName(group.name)
  }

  const handleNameSave = () => {
    if (tempName.trim() && tempName !== group.name) {
      onUpdateGroup({ name: tempName.trim() })
    }
    setIsEditingName(false)
  }

  const handleNameCancel = () => {
    setTempName(group.name)
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

  // 分组删除
  const handleDelete = () => {
    const confirmMessage = t('settings.systemPrompt.confirmDeleteGroup') ||
      '确定要删除此分组及其包含的所有提示词吗？'

    if (confirm(confirmMessage)) {
      onDeleteGroup()
    }
  }

  const groupStats = SystemPromptGenerator.getGroupStats(group)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`smtcmp-provider-section ${isDragging ? 'smtcmp-provider-dragging' : ''}`}
      data-group-id={group.id}
    >
      <div
        className={`smtcmp-provider-header ${!isEditingName ? 'smtcmp-clickable' : ''}`}
        onClick={(e: React.MouseEvent) => {
          // 只在非编辑模式下且点击的不是特定交互元素时才触发展开/收起
          if (!isEditingName &&
              !e.defaultPrevented &&
              !(e.target as Element).closest('.smtcmp-provider-drag-handle, .smtcmp-provider-actions, .smtcmp-provider-expand-btn')) {
            console.log('PromptGroupItem: header clicked for group:', group.id, 'name:', group.name)
            onToggleExpanded()
          }
        }}
        onKeyDown={(e: React.KeyboardEvent) => {
          // 只在非编辑模式下且按下了Enter或空格键时才触发展开/收起
          if (!isEditingName && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault()
            console.log('PromptGroupItem: keyboard expand for group:', group.id)
            onToggleExpanded()
          }
        }}
        role={!isEditingName ? "button" : undefined}
        tabIndex={!isEditingName ? 0 : -1} // 编辑模式下设为-1，避免被聚焦
      >
        <span
          className="smtcmp-provider-drag-handle"
          aria-label={t('settings.providers.dragHandle', 'Drag to reorder')}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
          {...listeners}
          {...attributes}
        >
          <GripVertical />
        </span>

        <div
          className="smtcmp-provider-expand-btn"
          onClick={(e: React.MouseEvent) => {
            console.log('PromptGroupItem: expand button clicked for group:', group.id, 'name:', group.name)
            e.stopPropagation()
            e.preventDefault()
            onToggleExpanded()
          }}
          role="button"
          tabIndex={0}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              console.log('PromptGroupItem: keyboard expand for group:', group.id)
              onToggleExpanded()
            }
          }}
          onMouseDown={(e: React.MouseEvent) => {
            e.stopPropagation()
            e.preventDefault()
          }}
        >
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </div>

        <div className="smtcmp-provider-info">
          {isEditingName ? (
            <div onClick={(e: React.MouseEvent) => e.stopPropagation()} onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}>
              <ObsidianTextInput
                value={tempName}
                onChange={setTempName}
                placeholder={t('settings.systemPrompt.groupNamePlaceholder') || '分组名称'}
                onKeyDown={handleNameKeyDown}
                onBlur={handleNameBlur}
              />
            </div>
          ) : (
            <span
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation() // 阻止事件冒泡到头部，防止触发展开/收起
                handleNameEdit()
              }}
              title={t('settings.systemPrompt.editGroupName') || '点击编辑分组名称'}
              style={{ cursor: 'pointer' }}
            >
              {group.name}
            </span>
          )}
        </div>
        
        <div className="smtcmp-provider-stats">
          <span className="smtcmp-provider-type">
            {t('settings.systemPrompt.enabledPrompts')?.replace('{enabled}', groupStats.split('/')[0])
              ?.replace('{total}', groupStats.split('/')[1]) ||
              `${groupStats}`}
          </span>
        </div>

        <div className="smtcmp-provider-actions">
          <ObsidianToggle
            value={group.enabled}
            onChange={(value) => {
              onToggleGroup(value)
            }}
          />
          <button
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              onAddPrompt()
            }}
            className="smtcmp-add-prompt-icon-btn"
            title={t('settings.systemPrompt.addPrompt') || '添加提示词'}
          >
            <Plus />
          </button>
          <button
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
              handleDelete()
            }}
            className="clickable-icon"
            title={t('settings.systemPrompt.deleteGroup') || '删除分组'}
          >
            <Trash2 />
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="smtcmp-provider-models">
          <div className="smtcmp-models-subsection">
            <PromptModuleList
              prompts={group.prompts}
              groupId={group.id}
              onUpdatePrompt={onUpdatePrompt}
              onDeletePrompt={onDeletePrompt}
              onTogglePrompt={onTogglePrompt}
              onDragEnd={onPromptDragEnd}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default PromptGroupItem