import { ModularPromptData, PromptGroup, PromptModule } from '../settings/schema/setting.types'
import { SystemPromptGenerator } from './systemPromptGenerator'

/**
 * 系统提示词管理器
 * 负责管理模块化系统提示词的状态和变更通知
 */
export class SystemPromptManager {
  private static instance: SystemPromptManager
  private changeListeners: Set<(prompt: string) => void> = new Set()

  static getInstance(): SystemPromptManager {
    if (!SystemPromptManager.instance) {
      SystemPromptManager.instance = new SystemPromptManager()
    }
    return SystemPromptManager.instance
  }

  /**
   * 生成系统提示词并通知监听器
   */
  generateAndUpdatePrompt(modularData: ModularPromptData): string {
    const systemPrompt = SystemPromptGenerator.generateSystemPrompt(modularData)
    
    // 通知所有监听器
    this.changeListeners.forEach(listener => listener(systemPrompt))
    
    return systemPrompt
  }

  /**
   * 添加变更监听器
   */
  addChangeListener(listener: (prompt: string) => void): () => void {
    this.changeListeners.add(listener)
    
    // 返回取消监听的函数
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  /**
   * 验证模块化数据
   */
  validateModularData(data: ModularPromptData): {
    isValid: boolean
    errors: string[]
  } {
    const errors: string[] = []
    
    if (!data.groups || !Array.isArray(data.groups)) {
      errors.push('分组数据必须是数组')
      return { isValid: false, errors }
    }
    
    data.groups.forEach((group, groupIndex) => {
      const groupValidation = SystemPromptGenerator.validatePromptGroup(group)
      if (!groupValidation.isValid) {
        errors.push(`分组${groupIndex + 1}: ${groupValidation.errors.join(', ')}`)
      }
    })
    
    return {
      isValid: errors.length === 0,
      errors
    }
  }

  /**
   * 获取分组状态统计信息
   */
  getGroupStats(group: PromptGroup): string {
    const enabledCount = group.prompts.filter(p => p.enabled).length
    const totalCount = group.prompts.length
    return `${enabledCount}/${totalCount}`
  }

  /**
   * 重新排序分组
   */
  reorderGroups(
    groups: PromptGroup[],
    oldIndex: number,
    newIndex: number,
  ): PromptGroup[] {
    return SystemPromptGenerator.reorderGroups(groups, oldIndex, newIndex)
  }

  /**
   * 重新排序分组内的提示词
   */
  reorderPromptsInGroup(
    group: PromptGroup,
    oldIndex: number,
    newIndex: number,
  ): PromptGroup {
    return SystemPromptGenerator.reorderPromptsInGroup(group, oldIndex, newIndex)
  }

  /**
   * 创建新的分组
   */
  createGroup(name: string): PromptGroup {
    return {
      id: SystemPromptGenerator.generateId(),
      name,
      enabled: true,
      order: 0,
      prompts: []
    }
  }

  /**
   * 创建新的提示词模块
   */
  createPrompt(name: string, content: string): PromptModule {
    return {
      id: SystemPromptGenerator.generateId(),
      name,
      content,
      enabled: true,
      order: 0
    }
  }

  /**
   * 切换分组启用状态
   */
  toggleGroupEnabled(
    groups: PromptGroup[],
    groupId: string,
    enabled: boolean,
  ): PromptGroup[] {
    return groups.map(group =>
      group.id === groupId ? { ...group, enabled } : group
    )
  }

  /**
   * 切换提示词启用状态
   */
  togglePromptEnabled(
    groups: PromptGroup[],
    groupId: string,
    promptId: string,
    enabled: boolean,
  ): PromptGroup[] {
    return groups.map(group => {
      if (group.id === groupId) {
        const updatedPrompts = group.prompts.map(prompt =>
          prompt.id === promptId ? { ...prompt, enabled } : prompt
        )
        return { ...group, prompts: updatedPrompts }
      }
      return group
    })
  }

  /**
   * 检查是否有启用的提示词
   */
  hasEnabledPrompts(data: ModularPromptData): boolean {
    if (!data.groups || data.groups.length === 0) {
      return false
    }

    return data.groups.some(group => 
      group.enabled && group.prompts.some(prompt => prompt.enabled)
    )
  }

  /**
   * 获取所有启用的提示词数量
   */
  getEnabledPromptsCount(data: ModularPromptData): number {
    if (!data.groups || data.groups.length === 0) {
      return 0
    }

    return data.groups.reduce((count, group) => {
      if (!group.enabled) return count
      return count + group.prompts.filter(prompt => prompt.enabled).length
    }, 0)
  }

  /**
   * 获取所有提示词数量
   */
  getTotalPromptsCount(data: ModularPromptData): number {
    if (!data.groups || data.groups.length === 0) {
      return 0
    }

    return data.groups.reduce((count, group) => {
      return count + group.prompts.length
    }, 0)
  }
}