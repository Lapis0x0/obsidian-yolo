import { AlertTriangle, X } from 'lucide-react'
import { Platform } from 'obsidian'
import type { ReactNode } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import { openCommunityPluginsSettings } from '../../core/update/openCommunityPluginsSettings'
import { normalizePluginVersion } from '../../core/update/updateChecker'
import { useInstallationIncompleteBanner } from '../../hooks/useInstallationIncompleteBanner'
import { usePluginUpdate } from '../../hooks/usePluginUpdate'

function repairFilesMatch(
  left: string[] | undefined,
  right: string[],
): boolean {
  if (!left || left.length !== right.length) {
    return false
  }
  const sortedLeft = [...left].sort()
  const sortedRight = [...right].sort()
  return sortedLeft.every((file, index) => file === sortedRight[index])
}

export function InstallationIncompleteBanner(): ReactNode {
  const { t } = useLanguage()
  const plugin = usePlugin()
  const { app } = plugin
  const { detail, dismissed, dismiss } = useInstallationIncompleteBanner()
  const { state: updateState, canSelfUpdate, applyUpdate } = usePluginUpdate()

  if (!detail || dismissed) {
    return null
  }

  const {
    mainVersion,
    manifestVersion,
    stylesVersion,
    suspectFiles,
    targetVersion,
  } = detail
  const normalizedTarget = normalizePluginVersion(targetVersion)
  const repairFiles = [...new Set(suspectFiles)]
  const hasSelfUpdate = Platform.isDesktop && canSelfUpdate
  const isReadyForTarget =
    updateState.status === 'ready' &&
    updateState.version === normalizedTarget &&
    repairFilesMatch(updateState.repairFiles, repairFiles)
  const isDownloadingTarget =
    updateState.status === 'downloading' &&
    updateState.version === normalizedTarget &&
    repairFilesMatch(updateState.repairFiles, repairFiles)
  const isApplyingTarget =
    updateState.status === 'applying' &&
    updateState.version === normalizedTarget &&
    repairFilesMatch(updateState.repairFiles, repairFiles)

  const title = t(
    'update.installationIncompleteTitle',
    'Plugin installation incomplete',
  )
  const meta = t(
    'update.installationIncompleteMeta',
    'main.js {mainVersion} · manifest {manifestVersion} · styles {stylesVersion}',
  )
    .replace('{mainVersion}', mainVersion ?? '—')
    .replace('{manifestVersion}', manifestVersion)
    .replace('{stylesVersion}', stylesVersion ?? '—')
  const suspects = t(
    'update.installationIncompleteSuspects',
    'Files to repair: {files}',
  ).replace('{files}', repairFiles.join(', '))
  const notes = t(
    'update.installationIncompleteNotes',
    'Plugin files may not have downloaded completely. A repair download will start automatically; you can also retry below.',
  )
  const dismissLabel = t('update.dismiss', 'Dismiss')

  const resolveCtaLabel = (): string => {
    if (!hasSelfUpdate) {
      return t('update.updateInCommunityPlugins', 'Update in community plugins')
    }
    if (isReadyForTarget) {
      return t('update.repairAndReload', 'Repair and reload')
    }
    if (isDownloadingTarget) {
      return t('update.repairing', 'Repairing {{progress}}%').replace(
        '{{progress}}',
        String(Math.round(updateState.progress)),
      )
    }
    if (isApplyingTarget) {
      return t('update.applying', 'Installing…')
    }
    return t('update.tryRepair', 'Try repair')
  }

  const ctaDisabled = isDownloadingTarget || isApplyingTarget

  return (
    <div className="yolo-installation-incomplete-banner">
      <div className="yolo-installation-incomplete-banner-row">
        <div
          className="yolo-installation-incomplete-banner-icon"
          aria-hidden="true"
        >
          <AlertTriangle size={18} strokeWidth={2} />
        </div>
        <div className="yolo-installation-incomplete-banner-body">
          <div className="yolo-installation-incomplete-banner-title">
            {title}
          </div>
          <div className="yolo-installation-incomplete-banner-meta">{meta}</div>
          <div className="yolo-installation-incomplete-banner-meta">
            {suspects}
          </div>
          <div className="yolo-installation-incomplete-banner-notes">
            {notes}
          </div>
        </div>
        <button
          type="button"
          className="yolo-installation-incomplete-banner-dismiss"
          onClick={() => {
            dismiss()
          }}
          aria-label={dismissLabel}
        >
          <X size={16} strokeWidth={2.25} />
        </button>
      </div>
      <div className="yolo-installation-incomplete-banner-actions">
        <button
          type="button"
          className="mod-cta yolo-installation-incomplete-banner-cta"
          disabled={ctaDisabled}
          onClick={() => {
            if (!hasSelfUpdate) {
              openCommunityPluginsSettings(app)
              return
            }
            if (isReadyForTarget) {
              applyUpdate()
              return
            }
            void plugin.repairIncompleteInstallation()
          }}
        >
          {resolveCtaLabel()}
        </button>
      </div>
    </div>
  )
}
