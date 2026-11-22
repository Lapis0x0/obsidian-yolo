import { Menu } from 'obsidian'

import type { ChatProject } from '../../../types/project.types'

import { PROJECT_ICONS } from './projectAppearance'

/**
 * 「移到项目」菜单：列出所有项目（勾选当前所在的），对话在项目里时多一项
 * 「移出项目」。历史列表的 ⋯ 菜单和侧边栏项目下的对话右键共用。
 */
export function showMoveToProjectMenu({
  projects,
  conversation,
  onMove,
  position,
  doc,
  removeLabel,
}: {
  projects: readonly ChatProject[]
  conversation: { id: string; projectId?: string }
  onMove: (conversationId: string, projectId: string | null) => unknown
  position: { x: number; y: number }
  doc: Document
  removeLabel: string
}) {
  const menu = new Menu()
  for (const project of projects) {
    menu.addItem((item) =>
      item
        .setTitle(project.name)
        .setIcon(project.icon ?? PROJECT_ICONS[0])
        .setChecked(project.id === conversation.projectId)
        .onClick(() => {
          if (project.id !== conversation.projectId) {
            void onMove(conversation.id, project.id)
          }
        }),
    )
  }
  if (projects.some((project) => project.id === conversation.projectId)) {
    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle(removeLabel)
        .setIcon('folder-output')
        .onClick(() => {
          void onMove(conversation.id, null)
        }),
    )
  }
  menu.showAtPosition(position, doc)
}
