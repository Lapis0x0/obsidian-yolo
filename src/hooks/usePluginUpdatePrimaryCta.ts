import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../contexts/language-context'
import { usePlugin } from '../contexts/plugin-context'
import { openCommunityPluginsSettings } from '../core/update/openCommunityPluginsSettings'
import type { YoloSettings } from '../settings/schema/setting.types'

import { usePluginUpdate } from './usePluginUpdate'
import { useUpdateCheck } from './useUpdateCheck'

export type PluginUpdatePrimaryCta = {
  label: string
  disabled: boolean
  onClick: () => void
}

export type UsePluginUpdatePrimaryCtaOptions = {
  onOpenCommunityPlugins?: () => void
}

export type UsePluginUpdatePrimaryCtaResult = {
  primaryCta: PluginUpdatePrimaryCta
  hasSelfUpdate: boolean
  isSelfUpdateError: boolean
  showCommunityPluginsFallback: boolean
  showDownloadProgress: boolean
  downloadProgress: number
  releaseUrl: string | null
  latestVersion: string | null
  openCommunityPlugins: () => void
}

export function usePluginUpdatePrimaryCta(
  options: UsePluginUpdatePrimaryCtaOptions = {},
): UsePluginUpdatePrimaryCtaResult {
  const { onOpenCommunityPlugins } = options
  const { t } = useLanguage()
  const plugin = usePlugin()
  const { app } = plugin
  const [settings, setSettings] = useState<YoloSettings>(() => plugin.settings)
  const { result } = useUpdateCheck()
  const {
    state: updateState,
    canSelfUpdate,
    startDownload,
    applyUpdate,
  } = usePluginUpdate()

  useEffect(() => {
    return plugin.addSettingsChangeListener((newSettings) => {
      setSettings(newSettings)
    })
  }, [plugin])

  const autoUpdateEnabled = settings.pluginUpdateAutoDownloadEnabled ?? true
  const hasSelfUpdate =
    autoUpdateEnabled &&
    canSelfUpdate &&
    Boolean(result?.assets) &&
    Boolean(result?.hasUpdate)

  const latestVersion = result?.latestVersion ?? null
  const releaseUrl = result?.releaseUrl ?? null

  const openCommunityPlugins = useCallback(() => {
    openCommunityPluginsSettings(app)
    onOpenCommunityPlugins?.()
  }, [app, onOpenCommunityPlugins])

  const primaryCta = useMemo((): PluginUpdatePrimaryCta => {
    if (!hasSelfUpdate) {
      return {
        label: t('update.goUpdate', 'Update'),
        disabled: false,
        onClick: openCommunityPlugins,
      }
    }

    const version = result!.latestVersion
    const isSameVersion =
      updateState.status !== 'idle' && updateState.version === version

    if (updateState.status === 'ready' && isSameVersion) {
      return {
        label: t('update.installAndReload', 'Install and reload'),
        disabled: false,
        onClick: () => {
          applyUpdate()
        },
      }
    }

    if (updateState.status === 'downloading' && isSameVersion) {
      return {
        label: t('update.downloading', 'Downloading {{progress}}%').replace(
          '{{progress}}',
          String(Math.round(updateState.progress)),
        ),
        disabled: true,
        onClick: () => {},
      }
    }

    if (updateState.status === 'applying' && isSameVersion) {
      return {
        label: t('update.applying', 'Installing…'),
        disabled: true,
        onClick: () => {},
      }
    }

    if (updateState.status === 'error' && isSameVersion) {
      return {
        label: t('update.downloadUpdate', 'Download update'),
        disabled: false,
        onClick: () => {
          startDownload()
        },
      }
    }

    return {
      label: t('update.downloadUpdate', 'Download update'),
      disabled: false,
      onClick: () => {
        startDownload()
      },
    }
  }, [
    applyUpdate,
    hasSelfUpdate,
    openCommunityPlugins,
    result,
    startDownload,
    t,
    updateState,
  ])

  const isSelfUpdateError =
    hasSelfUpdate &&
    updateState.status === 'error' &&
    updateState.version === (latestVersion ?? '')

  const showCommunityPluginsFallback = !hasSelfUpdate || isSelfUpdateError

  const showDownloadProgress =
    hasSelfUpdate &&
    updateState.status === 'downloading' &&
    updateState.version === (latestVersion ?? '')

  return {
    primaryCta,
    hasSelfUpdate,
    isSelfUpdateError,
    showCommunityPluginsFallback,
    showDownloadProgress,
    downloadProgress:
      updateState.status === 'downloading' ? updateState.progress : 0,
    releaseUrl,
    latestVersion,
    openCommunityPlugins,
  }
}
