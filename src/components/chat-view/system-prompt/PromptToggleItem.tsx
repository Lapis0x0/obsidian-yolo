import { PromptModule } from '../../../settings/schema/setting.types'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import './styles.css'

export type PromptToggleItemProps = {
  prompt: PromptModule
  groupId: string
  onToggle: (groupId: string, promptId: string, enabled: boolean) => void
}

export const PromptToggleItem: React.FC<PromptToggleItemProps> = ({
  prompt,
  groupId,
  onToggle,
}) => {
  const handleToggle = (enabled: boolean) => {
    onToggle(groupId, prompt.id, enabled)
  }

  return (
    <div className="smtcmp-system-prompt-item" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      width: '100%',
      padding: '8px 12px',
      borderRadius: '4px',
      marginBottom: '4px'
    }}>
      <div className="smtcmp-system-prompt-item-name" style={{
        flex: 1,
        marginRight: '8px',
        fontSize: '13px',
        color: 'var(--text-normal)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        lineHeight: '1.2'
      }}>
        {prompt.name}
      </div>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        flexShrink: 0,
        verticalAlign: 'middle'
      }}>
        <ObsidianToggle
          value={prompt.enabled}
          onChange={handleToggle}
        />
      </div>
    </div>
  )
}