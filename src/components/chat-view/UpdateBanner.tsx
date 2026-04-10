import { Download, X } from 'lucide-react'
import type { ReactNode } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useUpdateCheck } from '../../hooks/useUpdateCheck'

function interpolateVersion(template: string, version: string): string {
  return template.split('{version}').join(version)
}

export function UpdateBanner(): ReactNode {
  const { t } = useLanguage()
  const plugin = usePlugin()
  const { app } = plugin
  const { result, dismissed, dismiss } = useUpdateCheck()

  if (!result?.hasUpdate || dismissed) {
    return null
  }

  const title = interpolateVersion(
    t(
      'update.newVersionAvailable',
      'New version {version} is available',
    ),
    result.latestVersion,
  )

  const currentLabel = t('update.currentVersion', 'Current')
  const viewDetails = t('update.viewDetails', 'Go check for updates')
  const dismissLabel = t('update.dismiss', 'Dismiss')

  return (
    <div className="smtcmp-update-banner">
      <div className="smtcmp-update-banner-row">
        <div className="smtcmp-update-banner-icon" aria-hidden="true">
          <Download size={18} strokeWidth={2} />
        </div>
        <div className="smtcmp-update-banner-body">
          <div className="smtcmp-update-banner-title">{title}</div>
          <div className="smtcmp-update-banner-meta">
            {currentLabel}: v{plugin.manifest.version}
          </div>
          {result.releaseNotes ? (
            <div className="smtcmp-update-banner-notes">{result.releaseNotes}</div>
          ) : null}
        </div>
        <button
          type="button"
          className="smtcmp-update-banner-dismiss"
          onClick={() => {
            dismiss()
          }}
          aria-label={dismissLabel}
          title={dismissLabel}
        >
          <X size={16} strokeWidth={2.25} />
        </button>
      </div>
      <div className="smtcmp-update-banner-actions">
        <button
          type="button"
          className="mod-cta"
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
