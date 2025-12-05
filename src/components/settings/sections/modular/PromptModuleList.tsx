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

import { useLanguage } from '../../../../contexts/language-context'
import { PromptModule } from '../../../../settings/schema/setting.types'
import PromptModuleItem from './PromptModuleItem'

interface PromptModuleListProps {
  prompts: PromptModule[]
  groupId: string
  onUpdatePrompt: (promptId: string, updates: any) => void
  onDeletePrompt: (promptId: string) => void
  onTogglePrompt: (promptId: string, enabled: boolean) => void
  onDragEnd: (groupId: string, event: DragEndEvent) => void
}

const PromptModuleList: React.FC<PromptModuleListProps> = ({
  prompts,
  groupId,
  onUpdatePrompt,
  onDeletePrompt,
  onTogglePrompt,
  onDragEnd,
}) => {
  const { t } = useLanguage()
  const sensors = useSensors(useSensor(PointerSensor))

  const handleDragEnd = (event: DragEndEvent) => {
    console.log('PromptModuleList: handleDragEnd called for group:', groupId, 'event:', event)
    onDragEnd(groupId, event)
  }

  if (prompts.length === 0) {
    return (
      <div className="smtcmp-prompt-list-empty">
        {t('settings.systemPrompt.noPrompts') || '暂无提示词'}
      </div>
    )
  }

  console.log('PromptModuleList: rendering prompts for group:', groupId, 'prompts:', prompts.map(p => ({ id: p.id, name: p.name })))
  return (
    <div className="smtcmp-prompt-list">
      <DndContext
        sensors={sensors}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={prompts.map(p => p.id)}
          strategy={verticalListSortingStrategy}
        >
          <table className="smtcmp-models-table">
            <colgroup>
              <col width={16} />
              <col />
              <col width={60} />
              <col width={60} />
            </colgroup>
            <thead>
              <tr>
                <th></th>
                <th>{t('settings.systemPrompt.promptName') || '提示词名称'}</th>
                <th>{t('settings.systemPrompt.enable') || '启用'}</th>
                <th>{t('settings.systemPrompt.actions') || '操作'}</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map(prompt => (
                <PromptModuleItem
                  key={prompt.id}
                  prompt={prompt}
                  groupId={groupId}
                  onUpdatePrompt={onUpdatePrompt}
                  onDeletePrompt={onDeletePrompt}
                  onTogglePrompt={onTogglePrompt}
                  onDragEnd={handleDragEnd}
                />
              ))}
            </tbody>
          </table>
        </SortableContext>
      </DndContext>
    </div>
  )
}

export default PromptModuleList