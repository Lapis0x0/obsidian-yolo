import * as Popover from '@radix-ui/react-popover'
import { Bot, Check, ChevronDown, ChevronUp, Cpu } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import type { CliRuntimeScope, HermesProfile } from '../../core/cli-runtime'
import { YoloPopoverContent } from '../common/popover'

/**
 * Mirrors `HERMES_DEFAULT_PROFILE_ID` (core/cli-runtime/hermes/profiles.ts).
 * That module is desktop-only (statically imports `node:fs`), so the UI
 * layer cannot import it directly without pulling node built-ins into the
 * mobile bundle graph — the literal is stable protocol knowledge shared with
 * `CliSessionRef.profileId`'s "undefined = default" convention, not a guess.
 */
const DEFAULT_HERMES_PROFILE_ID = 'default'

/** Matches `AssistantSelector`'s model label: keep the slug, drop the vendor. */
const toModelLabel = (model: string): string =>
  model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model

export type HermesProfileSelectorProps = {
  cliRuntimeScope: CliRuntimeScope
  /** `undefined` means the default profile (see `CliSessionRef.profileId`). */
  currentProfileId: string | undefined
  onProfileChange: (profileId: string | undefined) => void
}

/**
 * Chat-header profile picker for Hermes — the multi-agent equivalent of
 * `AssistantSelector`, and deliberately its visual twin: it reuses that
 * component's `yolo-assistant-selector-*` classes rather than defining a
 * parallel set, because a header picker answering "who am I talking to"
 * should look the same whichever runtime is active (`src/styles/README.md`
 * rules out renaming the existing classes into a shared prefix, since
 * external themes target them).
 *
 * It is still a separate component rather than a parameterization of
 * `AssistantSelector`: profiles have no tool count, no edit affordance and
 * no management modal, so folding them into one component would only grow
 * empty branches. Only the rows those concerns own are omitted here.
 *
 * Renders nothing until discovery finds more than one profile — a
 * single-profile install (the common case) gets nothing added to its header.
 */
export function HermesProfileSelector({
  cliRuntimeScope,
  currentProfileId,
  onProfileChange,
}: HermesProfileSelectorProps) {
  const { t } = useLanguage()
  const [open, setOpen] = useState(false)
  const [profiles, setProfiles] = useState<readonly HermesProfile[]>([])
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const refreshProfiles = useCallback(() => {
    void cliRuntimeScope
      .listHermesProfiles()
      .then(setProfiles)
      .catch((error: unknown) => {
        console.error('[YOLO] Failed to list Hermes profiles', error)
      })
  }, [cliRuntimeScope])

  // Discovery must run eagerly (not only on open) since the result decides
  // whether this component renders anything at all.
  useEffect(() => {
    refreshProfiles()
  }, [refreshProfiles])

  if (profiles.length <= 1) return null

  const resolvedCurrentId = currentProfileId ?? DEFAULT_HERMES_PROFILE_ID
  const currentProfile =
    profiles.find((profile) => profile.id === resolvedCurrentId) ?? profiles[0]

  const handleSelect = (profile: HermesProfile) => {
    setOpen(false)
    if (profile.id === resolvedCurrentId) return
    onProfileChange(
      profile.id === DEFAULT_HERMES_PROFILE_ID ? undefined : profile.id,
    )
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) refreshProfiles()
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          ref={triggerRef}
          className="yolo-assistant-selector-button"
          data-state={open ? 'open' : 'closed'}
          aria-label={t(
            'chat.hermesProfileSelector.accessibleLabel',
            'Hermes profile: {profile}',
          ).replace(
            '{profile}',
            currentProfile?.displayName ?? resolvedCurrentId,
          )}
        >
          <div className="yolo-assistant-selector-current-icon">
            <Bot size={14} />
          </div>
          <div className="yolo-assistant-selector-current">
            {currentProfile?.displayName ?? resolvedCurrentId}
          </div>
          <div className="yolo-assistant-selector-icon">
            {open ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          </div>
        </button>
      </Popover.Trigger>

      <YoloPopoverContent
        anchorRef={triggerRef}
        variant="default"
        minWidth={280}
        maxHeight={460}
        className="yolo-assistant-selector-content yolo-assistant-selector-content--palette"
        sideOffset={14}
      >
        <ul className="yolo-assistant-selector-list yolo-model-select-list">
          {profiles.map((profile) => {
            const isActive = profile.id === resolvedCurrentId
            return (
              <li key={profile.id} className="yolo-assistant-selector-row">
                <div
                  className={`yolo-assistant-selector-item ${
                    isActive ? 'selected' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="yolo-assistant-selector-item-main"
                    onClick={() => handleSelect(profile)}
                  >
                    <div className="yolo-assistant-selector-item-icon">
                      <Bot size={14} />
                    </div>
                    <div className="yolo-assistant-selector-item-content">
                      <div className="yolo-assistant-selector-item-name-row">
                        <span className="yolo-assistant-selector-item-name">
                          {profile.displayName}
                        </span>
                        {isActive && (
                          <Check
                            size={11}
                            className="yolo-assistant-selector-item-check"
                          />
                        )}
                      </div>
                      {profile.model && (
                        <div className="yolo-assistant-selector-item-meta">
                          <span className="yolo-assistant-selector-meta-chip">
                            <Cpu size={10} />
                            <span>{toModelLabel(profile.model)}</span>
                          </span>
                        </div>
                      )}
                    </div>
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </YoloPopoverContent>
    </Popover.Root>
  )
}
