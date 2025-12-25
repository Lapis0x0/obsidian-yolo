import { PromptGroup } from '../../../settings/schema/setting.types'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { PromptToggleItem } from './PromptToggleItem'
import './styles.css'

export type PromptGroupSectionProps = {
  group: PromptGroup
  onToggleGroup: (groupId: string, enabled: boolean) => void
  onTogglePrompt: (groupId: string, promptId: string, enabled: boolean) => void
}

export const PromptGroupSection: React.FC<PromptGroupSectionProps> = ({
  group,
  onToggleGroup,
  onTogglePrompt,
}) => {
  return (
    <div className="smtcmp-system-prompt-group">
      <div className="smtcmp-system-prompt-group-header">
        <div className="smtcmp-system-prompt-group-info">
          <h4>{group.name}</h4>
        </div>
        <ObsidianToggle
          value={group.enabled}
          onChange={(enabled) => onToggleGroup(group.id, enabled)}
        />
      </div>

      {group.enabled && group.prompts.length > 0 && (
        <div className="smtcmp-system-prompt-list">
          {group.prompts.map(prompt => (
            <PromptToggleItem
              key={prompt.id}
              prompt={prompt}
              groupId={group.id}
              onToggle={onTogglePrompt}
            />
          ))}
        </div>
      )}
    </div>
  )
}