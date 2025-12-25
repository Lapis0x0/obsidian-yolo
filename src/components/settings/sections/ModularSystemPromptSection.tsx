import React, { useState, useEffect } from 'react'
import { DndContext } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'

import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianButton } from '../../common/ObsidianButton'
import { useSettings } from '../../../contexts/settings-context'
import { useLanguage } from '../../../contexts/language-context'

import { SystemPromptGenerator } from '../../../utils/systemPromptGenerator'
import {
  ModularPromptData,
  PromptGroup,
  PromptModule,
} from '../../../settings/schema/setting.types'

import ModeToggle from './modular/ModeToggle'
import PromptGroupList from './modular/PromptGroupList'
import ModularSystemPromptPreview from './modular/ModularSystemPromptPreview'
import './modular/styles.css'

export enum DisplayMode {
  MODULAR = 'modular', // 模块化编辑模式
  PREVIEW = 'preview', // 预览模式
}

interface ModularSystemPromptSectionProps {
  className?: string
}

const ModularSystemPromptSection: React.FC<ModularSystemPromptSectionProps> = ({
  className = '',
}) => {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [displayMode, setDisplayMode] = useState<DisplayMode>(DisplayMode.MODULAR)
  const [modularData, setModularData] = useState<ModularPromptData>({ groups: [] })
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // 初始化和迁移逻辑
  useEffect(() => {
    if (SystemPromptGenerator.needsMigration(settings)) {
      const migratedData = SystemPromptGenerator.performMigration(settings.systemPrompt)
      handleModularDataUpdate(migratedData)
    } else if (settings.modularPromptData) {
      setModularData(settings.modularPromptData)
    }
  }, [settings])

  // 初始化展开状态（只在第一次加载时执行）
  useEffect(() => {
    if (expandedGroups.size === 0 && modularData.groups && modularData.groups.length > 0) {
      // 不再自动展开第一个分组，允许所有分组都收起
      console.log('ModularSystemPromptSection: initializing with all groups collapsed')
      setExpandedGroups(new Set())
    }
  }, [modularData.groups, expandedGroups.size])

  // 数据持久化和预览更新
  const handleModularDataUpdate = async (newData: ModularPromptData) => {
    console.log('ModularSystemPromptSection: handleModularDataUpdate called with:', newData)
    setModularData(newData)

    // 保存模块化数据到设置
    const systemPrompt = SystemPromptGenerator.generateSystemPrompt(newData)
    await setSettings({
      ...settings,
      modularPromptData: newData,
      systemPrompt: systemPrompt
    })
  }

  // 分组操作
  const handleAddGroup = async () => {
    const newGroup: PromptGroup = {
      id: SystemPromptGenerator.generateId(),
      name: t('settings.systemPrompt.defaultGroupName') || '新分组',
      enabled: true,
      order: modularData.groups.length,
      prompts: [],
    }

    const updatedData = {
      ...modularData,
      groups: [...modularData.groups, newGroup],
    }
    await handleModularDataUpdate(updatedData)

    // 展开新分组（可选，如果用户希望新分组自动展开）
    // 如果不希望自动展开，可以注释掉这部分代码
    setExpandedGroups(prev => {
      const newSet = new Set([...prev, newGroup.id])
      console.log('ModularSystemPromptSection: expanding new group:', newGroup.id, 'all expanded groups:', Array.from(newSet))
      return newSet
    })
  }

  const handleUpdateGroup = async (groupId: string, updates: Partial<PromptGroup>) => {
    const updatedGroups = modularData.groups.map((group: PromptGroup) =>
      group.id === groupId ? { ...group, ...updates } : group
    )
    await handleModularDataUpdate({ ...modularData, groups: updatedGroups })
  }

  const handleDeleteGroup = async (groupId: string) => {
    if (!confirm(t('settings.systemPrompt.confirmDeleteGroup'))) {
      return
    }

    const updatedGroups = modularData.groups.filter((group: PromptGroup) => group.id !== groupId)
    await handleModularDataUpdate({ ...modularData, groups: updatedGroups })

    // 收起已删除的分组
    setExpandedGroups(prev => {
      const newSet = new Set(prev)
      newSet.delete(groupId)
      return newSet
    })
  }

  const handleToggleGroup = async (groupId: string, enabled: boolean) => {
    await handleUpdateGroup(groupId, { enabled })
  }

  const handleToggleGroupExpanded = (groupId: string) => {
    console.log('ModularSystemPromptSection: handleToggleGroupExpanded called with groupId:', groupId)
    console.log('ModularSystemPromptSection: current expandedGroups before toggle:', Array.from(expandedGroups))
    setExpandedGroups(prev => {
      const newSet = new Set(prev)
      if (newSet.has(groupId)) {
        newSet.delete(groupId)
        console.log('ModularSystemPromptSection: removing group from expanded:', groupId)
      } else {
        newSet.add(groupId)
        console.log('ModularSystemPromptSection: adding group to expanded:', groupId)
      }
      console.log('ModularSystemPromptSection: new expandedGroups after toggle:', Array.from(newSet))
      return newSet
    })
  }

  // 分组排序
  const handleGroupReorder = async (groups: PromptGroup[]) => {
    console.log('ModularSystemPromptSection: handleGroupReorder called with groups:', groups.map(g => ({ id: g.id, name: g.name })))
    await handleModularDataUpdate({ ...modularData, groups })
  }

  // 提示词操作
  const handleAddPrompt = async (groupId: string) => {
    const newPrompt: PromptModule = {
      id: SystemPromptGenerator.generateId(),
      name: t('settings.systemPrompt.defaultPromptName') || '新提示词',
      content: t('settings.systemPrompt.defaultPromptContent') || '请在此输入提示词内容',
      enabled: true,
      order: modularData.groups.find((g: PromptGroup) => g.id === groupId)?.prompts.length || 0,
    }

    const updatedGroups = modularData.groups.map((group: PromptGroup) =>
      group.id === groupId
        ? { ...group, prompts: [...group.prompts, newPrompt] }
        : group
    )
    await handleModularDataUpdate({ ...modularData, groups: updatedGroups })
  }

  const handleUpdatePrompt = async (groupId: string, promptId: string, updates: Partial<PromptModule>) => {
    const updatedGroups = modularData.groups.map((group: PromptGroup) => {
      if (group.id === groupId) {
        const updatedPrompts = group.prompts.map((prompt: PromptModule) =>
          prompt.id === promptId ? { ...prompt, ...updates } : prompt
        )
        return { ...group, prompts: updatedPrompts }
      }
      return group
    })
    await handleModularDataUpdate({ ...modularData, groups: updatedGroups })
  }

  const handleDeletePrompt = async (groupId: string, promptId: string) => {
    if (!confirm(t('settings.systemPrompt.confirmDeletePrompt'))) {
      return
    }

    const updatedGroups = modularData.groups.map((group: PromptGroup) => {
      if (group.id === groupId) {
        const updatedPrompts = group.prompts.filter((prompt: PromptModule) => prompt.id !== promptId)
        return { ...group, prompts: updatedPrompts }
      }
      return group
    })
    await handleModularDataUpdate({ ...modularData, groups: updatedGroups })
  }

  const handleTogglePrompt = async (groupId: string, promptId: string, enabled: boolean) => {
    await handleUpdatePrompt(groupId, promptId, { enabled })
  }

  // 模式切换
  const handleModeChange = async (mode: DisplayMode) => {
    setDisplayMode(mode)
  }

  // 拖拽处理
  const handleDragEnd = async ({ active, over }: any) => {
    if (!over || active.id === over.id) return

    const oldIndex = modularData.groups.findIndex((g: PromptGroup) => g.id === active.id)
    const newIndex = modularData.groups.findIndex((g: PromptGroup) => g.id === over.id)

    if (oldIndex !== -1 && newIndex !== -1) {
      const reorderedGroups = arrayMove(modularData.groups, oldIndex, newIndex)
      await handleGroupReorder(reorderedGroups)
    }
  }

  console.log('ModularSystemPromptSection: rendering with expandedGroups:', Array.from(expandedGroups))
  console.log('ModularSystemPromptSection: rendering groups:', modularData.groups.map(g => ({ id: g.id, name: g.name })))

  return (
    <div className={`smtcmp-settings-section ${className}`}>
      <div className="smtcmp-settings-header">
        {t('settings.systemPrompt.title')}
      </div>

      <div className="smtcmp-settings-desc">
        <span>{t('settings.systemPrompt.desc') || '管理模块化系统提示词，可以组织和重用不同的提示词组件'}</span>
      </div>

      <div className="smtcmp-providers-models-container">
        {/* 模式切换 */}
        <div className="smtcmp-mode-toggle-container">
          <ModeToggle mode={displayMode} onModeChange={handleModeChange} />
        </div>
        
        {/* 模块化模式 */}
        {displayMode === DisplayMode.MODULAR && (
          <>
            <PromptGroupList
              groups={modularData.groups}
              expandedGroups={expandedGroups}
              onToggleExpanded={handleToggleGroupExpanded}
              onUpdateGroup={handleUpdateGroup}
              onDeleteGroup={handleDeleteGroup}
              onToggleGroup={handleToggleGroup}
              onAddPrompt={handleAddPrompt}
              onUpdatePrompt={handleUpdatePrompt}
              onDeletePrompt={handleDeletePrompt}
              onTogglePrompt={handleTogglePrompt}
              onGroupReorder={handleGroupReorder}
            />

            <button
              className="smtcmp-add-provider-btn"
              onClick={handleAddGroup}
            >
              + {t('settings.systemPrompt.addGroup')}
            </button>
          </>
        )}
        
        {/* 预览模式 */}
        {displayMode === DisplayMode.PREVIEW && (
          <ModularSystemPromptPreview
            systemPrompt={settings.systemPrompt}
          />
        )}
      </div>
    </div>
  )
}

export default ModularSystemPromptSection