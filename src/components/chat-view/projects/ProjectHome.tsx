import { FileText, FolderOpen, Settings2 } from 'lucide-react'

import { useApp } from '../../../contexts/app-context'
import { useLanguage } from '../../../contexts/language-context'
import type { ChatProject } from '../../../types/project.types'
import { ObsidianIcon } from '../../common/ObsidianIcon'

import { PROJECT_COLORS, PROJECT_ICONS } from './projectAppearance'
import { useExistingInstructionFiles } from './ProjectSettingsModal'

const projectColorStyle = (project: ChatProject) =>
  ({
    '--yolo-project-color': project.color ?? PROJECT_COLORS[0],
  }) as React.CSSProperties

/**
 * 项目主页：项目里新对话的空状态。说明这个项目的边界（工作区、项目指令），
 * 并给出项目设定的入口；输入框就在下面，直接开始。
 */
function ProjectHomeDetails({
  project,
  onOpenSettings,
}: {
  project: ChatProject
  onOpenSettings: () => void
}) {
  const { t } = useLanguage()
  const app = useApp()
  const instructionFiles = useExistingInstructionFiles(
    app,
    project.workspaceScope,
  )
  const { include, exclude } = project.workspaceScope
  const workspaceText =
    include.length > 0
      ? include.join(t('chat.projects.listSeparator', ', '))
      : t('chat.projects.wholeVault', 'Whole vault')

  return (
    <div className="yolo-project-home">
      <div className="yolo-project-home-facts">
        <span className="yolo-project-home-fact">
          <FolderOpen size={13} />
          <span>{workspaceText}</span>
          {exclude.length > 0 ? (
            <span className="yolo-project-home-fact-muted">
              {t('chat.projects.excludedCount', '{count} excluded').replace(
                '{count}',
                String(exclude.length),
              )}
            </span>
          ) : null}
        </span>
        {instructionFiles.map((path) => (
          <button
            key={path}
            type="button"
            className="yolo-project-home-fact yolo-project-home-file"
            onClick={() => void app.workspace.openLinkText(path, '', 'tab')}
          >
            <FileText size={13} />
            <span>{path}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="yolo-project-home-settings"
        onClick={onOpenSettings}
      >
        <Settings2 size={13} />
        <span>{t('chat.projects.editTitle', 'Project settings')}</span>
      </button>
    </div>
  )
}

/** 交给对话面板的空状态覆盖（`emptyStateOverride`）。 */
export const buildProjectHomeEmptyState = (
  project: ChatProject,
  onOpenSettings: () => void,
) => ({
  title: project.name,
  description: (
    <ProjectHomeDetails project={project} onOpenSettings={onOpenSettings} />
  ),
  icon: (
    <span className="yolo-project-home-icon" style={projectColorStyle(project)}>
      <ObsidianIcon name={project.icon ?? PROJECT_ICONS[0]} />
    </span>
  ),
})
