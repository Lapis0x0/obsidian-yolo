import { App } from 'obsidian'
import { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import {
  cliPathOverrideExists,
  getCliPathOverride,
  setCliPathOverride,
} from '../../../core/cli-runtime/cli-path-override'
import type { CliRuntimeId } from '../../../core/cli-runtime/types'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'

type AgentCliPathSectionProps = {
  app: App
}

type CliPathRowProps = {
  app: App
  runtimeId: CliRuntimeId
  name: string
  desc: string
  placeholder: string
}

function CliPathRow({
  app,
  runtimeId,
  name,
  desc,
  placeholder,
}: CliPathRowProps) {
  const { t } = useLanguage()
  const [value, setValue] = useState(
    () => getCliPathOverride(app, runtimeId) ?? '',
  )
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void cliPathOverrideExists(value).then((exists) => {
      if (!cancelled) setMissing(!exists)
    })
    return () => {
      cancelled = true
    }
  }, [value])

  const handleChange = (next: string) => {
    setValue(next)
    setCliPathOverride(app, runtimeId, next)
  }

  return (
    <div>
      <ObsidianSetting name={name} desc={desc}>
        <ObsidianTextInput
          value={value}
          placeholder={placeholder}
          onChange={handleChange}
        />
      </ObsidianSetting>
      {missing && (
        <div className="yolo-settings-inline-error" role="alert">
          {t(
            'settings.agent.cliPathMissing',
            'This path does not exist on this device; auto-detection will be used instead.',
          )}
        </div>
      )}
    </div>
  )
}

export function AgentCliPathSection({ app }: AgentCliPathSectionProps) {
  const { t } = useLanguage()

  return (
    <>
      <CliPathRow
        app={app}
        runtimeId="claude-code"
        name={t('settings.agent.claudeCliPathName', 'Claude Code CLI path')}
        desc={t(
          'settings.agent.claudeCliPathDesc',
          'Custom path to the claude executable — paste the output of "which claude" ("where claude" on Windows). Leave empty to auto-detect. Stored on this device only.',
        )}
        placeholder="/opt/homebrew/bin/claude"
      />
      <CliPathRow
        app={app}
        runtimeId="codex"
        name={t('settings.agent.codexCliPathName', 'Codex CLI path')}
        desc={t(
          'settings.agent.codexCliPathDesc',
          'Custom path to the codex executable — paste the output of "which codex" ("where codex" on Windows). Leave empty to auto-detect. Stored on this device only.',
        )}
        placeholder="/opt/homebrew/bin/codex"
      />
      <CliPathRow
        app={app}
        runtimeId="hermes"
        name={t('settings.agent.hermesCliPathName', 'Hermes CLI path')}
        desc={t(
          'settings.agent.hermesCliPathDesc',
          'Custom path to the hermes executable — paste the output of "which hermes" ("where hermes" on Windows). Leave empty to auto-detect. Stored on this device only.',
        )}
        placeholder="~/.local/bin/hermes"
      />
      <CliPathRow
        app={app}
        runtimeId="pi"
        name={t('settings.agent.piCliPathName', 'pi CLI path')}
        desc={t(
          'settings.agent.piCliPathDesc',
          'Custom path to the pi executable — paste the output of "which pi" ("where pi" on Windows). Leave empty to auto-detect. Stored on this device only.',
        )}
        placeholder="/opt/homebrew/bin/pi"
      />
    </>
  )
}
