import { ModularPromptData, PromptGroup, PromptModule } from '../settings/schema/setting.types'

/**
 * 系统提示词生成器
 * 负责将模块化数据结构转换为最终的系统提示词字符串
 */
export class SystemPromptGenerator {
  /**
   * 从模块化数据生成系统提示词
   * @param data 模块化提示词数据
   * @returns 组合后的系统提示词字符串
   */
  static generateSystemPrompt(data: ModularPromptData): string {
    if (!data || !data.groups || data.groups.length === 0) {
      return ''
    }

    // 过滤并排序启用的分组
    const enabledGroups = data.groups
      .filter(group => group.enabled)
      .sort((a, b) => a.order - b.order)

    // 按分组顺序收集启用的提示词，每个分组内部按order排序
    const enabledPrompts: PromptModule[] = []
    for (const group of enabledGroups) {
      const groupPrompts = group.prompts
        .filter(prompt => prompt.enabled)
        .sort((a, b) => a.order - b.order)
      enabledPrompts.push(...groupPrompts)
    }

    // 拼接所有启用的提示词内容，每条提示词之间添加换行
    return enabledPrompts.map(prompt => prompt.content).join('\n')
  }

  /**
   * 生成唯一ID
   * @returns 唯一标识符
   */
  static generateId(): string {
    return `prompt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * 执行数据迁移：将现有的systemPrompt转换为模块化结构
   * @param existingSystemPrompt 现有的系统提示词内容
   * @returns 迁移后的模块化数据
   */
  static performMigration(existingSystemPrompt: string): ModularPromptData {
    if (!existingSystemPrompt || existingSystemPrompt.trim() === '') {
      return { groups: [] }
    }

    const migratedData: ModularPromptData = {
      groups: [
        {
          id: this.generateId(),
          name: '默认分组',
          enabled: true,
          order: 0,
          prompts: [
            {
              id: this.generateId(),
              name: '历史系统提示词',
              content: existingSystemPrompt,
              enabled: true,
              order: 0,
            },
          ],
        },
      ],
    }

    return migratedData
  }

  /**
   * 检查是否需要执行迁移
   * @param settings 插件设置
   * @returns 是否需要迁移
   */
  static needsMigration(settings: any): boolean {
    return (
      !settings.modularPromptData &&
      settings.systemPrompt &&
      settings.systemPrompt.trim() !== ''
    )
  }

  /**
   * 重新排序分组
   * @param groups 分组列表
   * @param oldIndex 原位置索引
   * @param newIndex 新位置索引
   * @returns 重新排序后的分组列表
   */
  static reorderGroups(
    groups: PromptGroup[],
    oldIndex: number,
    newIndex: number,
  ): PromptGroup[] {
    const result = Array.from(groups)
    const [removed] = result.splice(oldIndex, 1)
    result.splice(newIndex, 0, removed)

    // 更新order值
    return result.map((group, index) => ({
      ...group,
      order: index,
    }))
  }

  /**
   * 重新排序分组内的提示词
   * @param group 目标分组
   * @param oldIndex 原位置索引
   * @param newIndex 新位置索引
   * @returns 更新后的分组
   */
  static reorderPromptsInGroup(
    group: PromptGroup,
    oldIndex: number,
    newIndex: number,
  ): PromptGroup {
    const reorderedPrompts = Array.from(group.prompts)
    const [removed] = reorderedPrompts.splice(oldIndex, 1)
    reorderedPrompts.splice(newIndex, 0, removed)

    // 更新order值
    const updatedPrompts = reorderedPrompts.map((prompt, index) => ({
      ...prompt,
      order: index,
    }))

    return {
      ...group,
      prompts: updatedPrompts,
    }
  }

  /**
   * 获取分组状态统计信息
   * @param group 分组对象
   * @returns 启用/总数统计字符串
   */
  static getGroupStats(group: PromptGroup): string {
    const enabledCount = group.prompts.filter(p => p.enabled).length
    const totalCount = group.prompts.length
    return `${enabledCount}/${totalCount}`
  }

  /**
   * 验证提示词模块数据
   * @param prompt 提示词模块
   * @returns 验证结果
   */
  static validatePromptModule(prompt: PromptModule): {
    isValid: boolean
    errors: string[]
  } {
    const errors: string[] = []

    if (!prompt.id || prompt.id.trim() === '') {
      errors.push('提示词ID不能为空')
    }

    if (!prompt.name || prompt.name.trim() === '') {
      errors.push('提示词名称不能为空')
    } else if (prompt.name.length > 50) {
      errors.push('提示词名称不能超过50个字符')
    }

    if (!prompt.content || prompt.content.trim() === '') {
      errors.push('提示词内容不能为空')
    }

    if (typeof prompt.enabled !== 'boolean') {
      errors.push('提示词启用状态必须是布尔值')
    }

    if (typeof prompt.order !== 'number' || prompt.order < 0) {
      errors.push('提示词顺序必须是非负整数')
    }

    return {
      isValid: errors.length === 0,
      errors,
    }
  }

  /**
   * 验证提示词分组数据
   * @param group 分组对象
   * @returns 验证结果
   */
  static validatePromptGroup(group: PromptGroup): {
    isValid: boolean
    errors: string[]
  } {
    const errors: string[] = []

    if (!group.id || group.id.trim() === '') {
      errors.push('分组ID不能为空')
    }

    if (!group.name || group.name.trim() === '') {
      errors.push('分组名称不能为空')
    } else if (group.name.length > 30) {
      errors.push('分组名称不能超过30个字符')
    }

    if (typeof group.enabled !== 'boolean') {
      errors.push('分组启用状态必须是布尔值')
    }

    if (typeof group.order !== 'number' || group.order < 0) {
      errors.push('分组顺序必须是非负整数')
    }

    if (!Array.isArray(group.prompts)) {
      errors.push('分组提示词列表必须是数组')
    } else {
      // 验证每个提示词模块
      group.prompts.forEach((prompt, index) => {
        const promptValidation = this.validatePromptModule(prompt)
        if (!promptValidation.isValid) {
          errors.push(`提示词${index + 1}: ${promptValidation.errors.join(', ')}`)
        }
      })
    }

    return {
      isValid: errors.length === 0,
      errors,
    }
  }
}