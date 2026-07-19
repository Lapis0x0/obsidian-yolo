import type { RegisteredModuleSettingsContributionV1 } from '../../../core/modules/moduleSettingsContributions'

import { ModuleSettingsSection } from './ModuleSettingsSection'

export function LearningSection({
  moduleSettings = [],
  handoffState = 'ready',
  retryHandoff,
}: {
  moduleSettings?: readonly RegisteredModuleSettingsContributionV1[]
  handoffState?: 'pending' | 'ready' | 'failed'
  retryHandoff?: () => Promise<void>
}) {
  if (moduleSettings.length > 0) {
    return <ModuleSettingsSection registrations={moduleSettings} />
  }
  return (
    <LegacyLearningSection
      handoffState={handoffState}
      retryHandoff={retryHandoff}
    />
  )
}

function LegacyLearningSection({
  handoffState,
  retryHandoff,
}: {
  handoffState: 'pending' | 'ready' | 'failed'
  retryHandoff?: () => Promise<void>
}) {
  return (
    <div className="yolo-settings-section">
      <div className="yolo-module-settings-error" role="status">
        <span>
          {handoffState === 'failed'
            ? 'Learning is unavailable because its one-time settings handoff failed.'
            : 'Learning is unavailable. Manage or install the Learning module from Modules settings.'}
        </span>
        {handoffState === 'failed' && retryHandoff ? (
          <button
            type="button"
            className="yolo-module-card-retry"
            onClick={() => void retryHandoff().catch(() => undefined)}
          >
            Retry handoff
          </button>
        ) : null}
      </div>
    </div>
  )
}
