import { AlertTriangle, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../runtime/react-compat'
import { useInstallationIncompleteBanner } from '../../hooks/useInstallationIncompleteBanner'

export function InstallationIncompleteBanner(): ReactNode {
  const { t } = useLanguage()
  const plugin = usePlugin()
  const { app } = plugin
  const { detail, dismissed, dismiss } = useInstallationIncompleteBanner()

  if (!detail || dismissed) {
    return null
  }

  const { bakedVersion, manifestVersion } = detail
  const title = t(
    'update.installationIncompleteTitle',
    'Plugin installation incomplete',
  )
  const meta = t(
    'update.installationIncompleteMeta',
    'main.js {bakedVersion} · manifest {manifestVersion}',
  )
    .replace('{bakedVersion}', bakedVersion)
    .replace('{manifestVersion}', manifestVersion)
  const notes = t(
    'update.installationIncompleteNotes',
    'This usually means main.js did not finish downloading during an update. Back up data.json, remove the plugin, and reinstall.',
  )
  const dismissLabel = t('update.dismiss', 'Dismiss')
  const viewDetails = t('update.viewDetails', 'Go check for updates')

  return (
    <div className="smtcmp-installation-incomplete-banner">
      <div className="smtcmp-installation-incomplete-banner-row">
        <div
          className="smtcmp-installation-incomplete-banner-icon"
          aria-hidden="true"
        >
          <AlertTriangle size={18} strokeWidth={2} />
        </div>
        <div className="smtcmp-installation-incomplete-banner-body">
          <div className="smtcmp-installation-incomplete-banner-title">
            {title}
          </div>
          <div className="smtcmp-installation-incomplete-banner-meta">
            {meta}
          </div>
          <div className="smtcmp-installation-incomplete-banner-notes">
            {notes}
          </div>
        </div>
        <button
          type="button"
          className="smtcmp-installation-incomplete-banner-dismiss"
          onClick={() => {
            dismiss()
          }}
          aria-label={dismissLabel}
          title={dismissLabel}
        >
          <X size={16} strokeWidth={2.25} />
        </button>
      </div>
      <div className="smtcmp-installation-incomplete-banner-actions">
        <button
          type="button"
          className="mod-cta smtcmp-installation-incomplete-banner-cta"
          onClick={() => {
            // @ts-expect-error: setting property exists in Obsidian's App but is not typed
            app.setting.open()
            // @ts-expect-error: setting property exists in Obsidian's App but is not typed
            app.setting.openTabById('community-plugins')
          }}
        >
          {viewDetails}
        </button>
      </div>
    </div>
  )
}
