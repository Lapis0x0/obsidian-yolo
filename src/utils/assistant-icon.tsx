import * as LucideIcons from 'lucide-react'
import React from 'react'

import { AssistantIcon } from '../types/assistant.types'

/**
 * 默认助手图标
 */
export const DEFAULT_ASSISTANT_ICON: AssistantIcon = {
  type: 'lucide',
  value: 'Bot',
}

/**
 * 常用的 Lucide 图标列表（用于图标选择器）
 */
export const PRESET_LUCIDE_ICONS = [
  'Bot',
  'Sparkles',
  'Brain',
  'Zap',
  'Wand2',
  'MessageSquare',
  'Lightbulb',
  'Rocket',
  'Star',
  'Heart',
  'Smile',
  'Coffee',
  'Flame',
  'Crown',
  'Target',
  'BookOpen',
  'Cpu',
  'Database',
  'Code',
  'Terminal',
  'GitBranch',
  'Package',
  'Settings',
  'Wrench',
  'Hammer',
  'Shield',
  'Lock',
  'Key',
  'Eye',
  'Bell',
  'Music',
  'Camera',
  'Image',
  'File',
  'Folder',
  'Search',
  'Filter',
  'Send',
  'Mail',
  'Phone',
  'Globe',
  'Map',
  'Compass',
  'Navigation',
  'Briefcase',
  'Award',
  'Trophy',
  'Gift',
  'Umbrella',
] as const

/**
 * 常用的 Emoji 列表（用于图标选择器）
 */
export const PRESET_EMOJIS = [
  '🤖',
  '✨',
  '🧠',
  '⚡',
  '🪄',
  '💬',
  '💡',
  '🚀',
  '⭐',
  '❤️',
  '😊',
  '☕',
  '🔥',
  '👑',
  '🎯',
  '📚',
  '💻',
  '🗄️',
  '💾',
  '🖥️',
  '📱',
  '⌨️',
  '🖱️',
  '🎨',
  '🎭',
  '🎪',
  '🎬',
  '🎮',
  '🎲',
  '🎯',
  '🎪',
  '🎨',
  '🎭',
  '🎪',
  '🎬',
  '🎮',
  '🎲',
  '🏆',
  '🎖️',
  '🏅',
  '🥇',
  '🥈',
  '🥉',
  '🎁',
  '🎈',
  '🎉',
  '🎊',
  '🎃',
  '🎄',
] as const

/**
 * 渲染助手图标
 * @param icon - 图标配置对象，如果为 undefined 则使用默认图标
 * @param size - 图标大小（像素）
 * @param className - 额外的 CSS 类名
 * @returns React 元素
 */
export const renderAssistantIcon = (
  icon: AssistantIcon | undefined,
  size = 16,
  className?: string,
): React.ReactElement => {
  const iconConfig = icon || DEFAULT_ASSISTANT_ICON

  // 为不同类型的图标添加不同的类名
  const iconTypeClass =
    iconConfig.type === 'emoji' ? 'icon-emoji' : 'icon-lucide'
  const combinedClassName = className
    ? `${className} ${iconTypeClass}`
    : iconTypeClass

  if (iconConfig.type === 'emoji') {
    return (
      <span
        className={combinedClassName}
        style={{
          fontSize: `${size}px`,
          lineHeight: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {iconConfig.value}
      </span>
    )
  }

  // Lucide 图标
  type LucideIconComponent = React.ComponentType<{
    size?: number
    className?: string
  }>
  const lucideIconMap = LucideIcons as unknown as Record<
    string,
    LucideIconComponent
  >
  const IconComponent = lucideIconMap[iconConfig.value]

  if (!IconComponent) {
    // 如果图标不存在，降级到默认图标
    const DefaultIcon = lucideIconMap[DEFAULT_ASSISTANT_ICON.value]
    return <DefaultIcon size={size} className={combinedClassName} />
  }

  return <IconComponent size={size} className={combinedClassName} />
}

/**
 * 检查 Lucide 图标名称是否有效
 */
export const isValidLucideIcon = (iconName: string): boolean => {
  return iconName in LucideIcons
}
