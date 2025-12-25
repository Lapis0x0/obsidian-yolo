import React from 'react'
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'

import { PromptGroup, PromptModule } from '../../../../settings/schema/setting.types'
import PromptGroupItem from './PromptGroupItem'

interface PromptGroupListProps {
  groups: PromptGroup[]
  expandedGroups: Set<string>
  onToggleExpanded: (groupId: string) => void
  onUpdateGroup: (groupId: string, updates: Partial<PromptGroup>) => void
  onDeleteGroup: (groupId: string) => void
  onToggleGroup: (groupId: string, enabled: boolean) => void
  onAddPrompt: (groupId: string) => void
  onUpdatePrompt: (groupId: string, promptId: string, updates: Partial<PromptModule>) => void
  onDeletePrompt: (groupId: string, promptId: string) => void
  onTogglePrompt: (groupId: string, promptId: string, enabled: boolean) => void
  onGroupReorder: (groups: PromptGroup[]) => void
}

const PromptGroupList: React.FC<PromptGroupListProps> = ({
  groups,
  expandedGroups,
  onToggleExpanded,
  onUpdateGroup,
  onDeleteGroup,
  onToggleGroup,
  onAddPrompt,
  onUpdatePrompt,
  onDeletePrompt,
  onTogglePrompt,
  onGroupReorder,
}) => {
  const sensors = useSensors(useSensor(PointerSensor))

  // 处理分组拖拽排序
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (!over || active.id === over.id) return

    const oldIndex = groups.findIndex(g => g.id === active.id)
    const newIndex = groups.findIndex(g => g.id === over.id)

    if (oldIndex !== -1 && newIndex !== -1) {
      const reorderedGroups = arrayMove(groups, oldIndex, newIndex)

      // 更新order值
      const updatedGroups = reorderedGroups.map((group, index) => ({
        ...group,
        order: index,
      }))

      // 通知父组件更新
      onGroupReorder(updatedGroups)
    }
  }

  // 处理分组内提示词拖拽排序
  const handlePromptDragEnd = (groupId: string, event: DragEndEvent) => {
    console.log('PromptGroupList: handlePromptDragEnd called for groupId:', groupId, 'event:', event)
    const { active, over } = event

    if (!over || active.id === over.id) return

    const group = groups.find(g => g.id === groupId)
    if (!group) {
      console.log('PromptGroupList: group not found for groupId:', groupId)
      return
    }

    const oldIndex = group.prompts.findIndex((p: PromptModule) => p.id === active.id)
    const newIndex = group.prompts.findIndex((p: PromptModule) => p.id === over.id)

    console.log('PromptGroupList: drag indices - oldIndex:', oldIndex, 'newIndex:', newIndex)
    console.log('PromptGroupList: before drag - prompts:', group.prompts.map(p => ({ id: p.id, name: p.name, order: p.order })))

    if (oldIndex !== -1 && newIndex !== -1) {
      const reorderedPrompts = arrayMove(group.prompts, oldIndex, newIndex)

      // 更新order值
      const updatedPrompts = reorderedPrompts.map((prompt, index) => ({
        ...(prompt as PromptModule),
        order: index,
      }))

      console.log('PromptGroupList: after drag - prompts:', updatedPrompts.map(p => ({ id: p.id, name: p.name, order: p.order })))

      // 找到要更新的分组
      const updatedGroups = groups.map(g =>
        g.id === groupId
          ? { ...g, prompts: updatedPrompts }
          : g
      )

      console.log('PromptGroupList: updatedGroups:', updatedGroups.map(g => ({ id: g.id, name: g.name, promptsCount: g.prompts.length })))

      // 调用分组重排序回调
      onGroupReorder(updatedGroups)
    }
  }

  return (
    <div className="smtcmp-modular-container">
      <DndContext
        sensors={sensors}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={groups.map(g => g.id)}
          strategy={verticalListSortingStrategy}
        >
          {groups.map(group => {
            console.log('PromptGroupList: rendering group:', group.id, 'name:', group.name, 'isExpanded:', expandedGroups.has(group.id))
            return (
              <PromptGroupItem
                key={group.id}
                group={group}
                isExpanded={expandedGroups.has(group.id)}
                onToggleExpanded={() => {
                  console.log('PromptGroupList: toggling expanded for group:', group.id, 'name:', group.name)
                  onToggleExpanded(group.id)
                }}
                onUpdateGroup={(updates) => onUpdateGroup(group.id, updates)}
                onDeleteGroup={() => onDeleteGroup(group.id)}
                onToggleGroup={(enabled) => onToggleGroup(group.id, enabled)}
                onAddPrompt={() => onAddPrompt(group.id)}
                onUpdatePrompt={(promptId, updates) => onUpdatePrompt(group.id, promptId, updates)}
                onDeletePrompt={(promptId) => onDeletePrompt(group.id, promptId)}
                onTogglePrompt={(promptId, enabled) => onTogglePrompt(group.id, promptId, enabled)}
                onPromptDragEnd={handlePromptDragEnd}
              />
            )
          })}
        </SortableContext>
      </DndContext>
    </div>
  )
}

export default PromptGroupList