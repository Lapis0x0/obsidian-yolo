import {
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import { App, Notice } from 'obsidian'
import { useState, useSyncExternalStore } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type {
  ConfirmedModuleCandidate,
  ModuleManagerSnapshot,
  ModuleRecord,
} from '../../../core/modules'
import YoloPlugin from '../../../main'
import { ConfirmModal } from '../../modals/ConfirmModal'

type ModulesTabProps = {
  app: App
  plugin: YoloPlugin
}

const INSTALLED_STATUSES = new Set<ModuleRecord['status']>([
  'installed',
  'active',
  'disabled',
  'update-available',
  'failed',
])

function ModuleCard({
  module,
  operationModuleId,
  onInstall,
}: {
  module: ModuleRecord
  operationModuleId: string | null
  onInstall: (module: ModuleRecord) => void
}) {
  const { t } = useLanguage()
  const name = module.catalog?.name ?? module.id
  const description = module.catalog?.description
  const version = module.installed?.version ?? module.catalog?.version
  const availableVersion =
    module.status === 'update-available' ? module.catalog?.version : undefined
  const statusLabels: Record<ModuleRecord['status'], string> = {
    available: t('settings.modules.statuses.available'),
    installed: t('settings.modules.statuses.installed'),
    active: t('settings.modules.statuses.active'),
    disabled: t('settings.modules.statuses.disabled'),
    'update-available': t('settings.modules.statuses.updateAvailable'),
    failed: t('settings.modules.statuses.failed'),
  }
  const action =
    module.status === 'available'
      ? 'install'
      : module.status === 'update-available'
        ? 'update'
        : undefined
  const isOperating = operationModuleId === module.id
  const hasOperation = operationModuleId !== null

  return (
    <article
      className={`yolo-module-card yolo-module-card--${module.status}`}
      data-module-id={module.id}
    >
      <div className="yolo-module-card-main">
        <div className="yolo-module-card-heading">
          <h4 className="yolo-module-card-name">{name}</h4>
          <span className="yolo-module-card-badge">
            {statusLabels[module.status]}
          </span>
        </div>
        {description && (
          <p className="yolo-module-card-description">{description}</p>
        )}
        {version && (
          <div className="yolo-module-card-meta">
            <span>
              {t('settings.modules.version').replace('{version}', version)}
            </span>
            {availableVersion && (
              <span className="yolo-module-card-update-version">
                {t('settings.modules.availableVersion').replace(
                  '{version}',
                  availableVersion,
                )}
              </span>
            )}
          </div>
        )}
        {module.installed?.error && (
          <p className="yolo-module-card-error" role="alert">
            {module.installed.error}
          </p>
        )}
      </div>
      <div className="yolo-module-card-actions">
        {action && (
          <button
            type="button"
            className="yolo-module-card-action"
            onClick={() => onInstall(module)}
            disabled={hasOperation}
            aria-busy={isOperating || undefined}
          >
            {isOperating && (
              <LoaderCircle
                className="yolo-module-card-action-icon is-spinning"
                aria-hidden="true"
              />
            )}
            <span>
              {t(
                isOperating
                  ? action === 'update'
                    ? 'settings.modules.updating'
                    : 'settings.modules.installing'
                  : action === 'update'
                    ? 'settings.modules.update'
                    : 'settings.modules.install',
              )}
            </span>
          </button>
        )}
      </div>
    </article>
  )
}

function ModuleGroup({
  description,
  emptyMessage,
  modules,
  operationModuleId,
  onInstall,
  title,
}: {
  description: string
  emptyMessage: string
  modules: ReadonlyArray<ModuleRecord>
  operationModuleId: string | null
  onInstall: (module: ModuleRecord) => void
  title: string
}) {
  return (
    <section className="yolo-modules-group">
      <div className="yolo-modules-group-header">
        <h3 className="yolo-modules-group-title">{title}</h3>
        <span className="yolo-modules-group-count">{modules.length}</span>
      </div>
      <p className="yolo-modules-group-description">{description}</p>
      {modules.length > 0 ? (
        <div className="yolo-modules-list">
          {modules.map((module) => (
            <ModuleCard
              key={module.id}
              module={module}
              operationModuleId={operationModuleId}
              onInstall={onInstall}
            />
          ))}
        </div>
      ) : (
        <p className="yolo-modules-group-empty">{emptyMessage}</p>
      )}
    </section>
  )
}

function ModuleErrorState({
  compact = false,
  snapshot,
}: {
  compact?: boolean
  snapshot: ModuleManagerSnapshot
}) {
  const { t } = useLanguage()
  const details = [
    snapshot.errors.catalog
      ? t('settings.modules.catalogError').replace(
          '{error}',
          snapshot.errors.catalog,
        )
      : undefined,
    snapshot.errors.installed
      ? t('settings.modules.installedError').replace(
          '{error}',
          snapshot.errors.installed,
        )
      : undefined,
  ].filter((detail): detail is string => Boolean(detail))

  return (
    <div
      className={`yolo-modules-state yolo-modules-state--error ${
        compact ? 'yolo-modules-state--compact' : ''
      }`}
      role="alert"
    >
      <TriangleAlert className="yolo-modules-state-icon" aria-hidden="true" />
      <div>
        <p className="yolo-modules-state-message">
          {t('settings.modules.loadError')}
        </p>
        {details.map((detail) => (
          <p key={detail} className="yolo-modules-state-detail">
            {detail}
          </p>
        ))}
      </div>
    </div>
  )
}

export function ModulesTab({ app, plugin }: ModulesTabProps) {
  const { t } = useLanguage()
  const [operationModuleId, setOperationModuleId] = useState<string | null>(
    null,
  )
  const manager = plugin.getModuleManager()
  const snapshot = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot,
  )
  const isLoading = snapshot.status === 'loading'
  const installed = snapshot.modules.filter((module) =>
    INSTALLED_STATUSES.has(module.status),
  )
  const available = snapshot.modules.filter(
    (module) => module.status === 'available',
  )

  const installCandidate = async (
    module: ModuleRecord,
    candidate: ConfirmedModuleCandidate,
    isUpdate: boolean,
  ) => {
    const name = module.catalog?.name ?? module.id
    try {
      await plugin.installConfirmedModuleCandidate(candidate)
      new Notice(
        t(
          isUpdate
            ? 'settings.modules.updateSuccess'
            : 'settings.modules.installSuccess',
        )
          .replace('{name}', name)
          .replace('{version}', candidate.expectedVersion),
        8000,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        t(
          isUpdate
            ? 'settings.modules.updateError'
            : 'settings.modules.installError',
        )
          .replace('{name}', name)
          .replace('{error}', message),
        8000,
      )
    } finally {
      setOperationModuleId((current) =>
        current === module.id ? null : current,
      )
    }
  }

  const openInstallConfirmation = (module: ModuleRecord) => {
    const name = module.catalog?.name ?? module.id
    const candidate = plugin.getModuleInstallCandidate(module.id)
    if (
      !candidate ||
      !module.catalog ||
      candidate.expectedVersion !== module.catalog.version
    ) {
      new Notice(
        t('settings.modules.candidateUnavailable').replace('{name}', name),
      )
      return
    }

    const isUpdate = module.status === 'update-available'
    setOperationModuleId(module.id)
    new ConfirmModal(app, {
      title: t(
        isUpdate
          ? 'settings.modules.confirmUpdateTitle'
          : 'settings.modules.confirmInstallTitle',
      ).replace('{name}', name),
      message: t('settings.modules.confirmMessage')
        .replace('{name}', name)
        .replace('{version}', candidate.expectedVersion)
        .replace('{sha256}', candidate.expectedManifestSha256),
      ctaText: t(
        isUpdate ? 'settings.modules.update' : 'settings.modules.install',
      ),
      onConfirm: () => {
        void installCandidate(module, candidate, isUpdate)
      },
      onCancel: () => {
        setOperationModuleId((current) =>
          current === module.id ? null : current,
        )
      },
    }).open()
  }

  return (
    <div className="yolo-modules-page">
      <header className="yolo-modules-header">
        <div className="yolo-modules-header-copy">
          <h2 className="yolo-settings-header yolo-modules-title">
            {t('settings.modules.title')}
          </h2>
          <p className="yolo-settings-desc yolo-modules-description">
            {t('settings.modules.description')}
          </p>
        </div>
        <button
          type="button"
          className="yolo-modules-refresh"
          onClick={() => void manager.refresh()}
          disabled={isLoading || operationModuleId !== null}
          aria-label={t(
            isLoading
              ? 'settings.modules.refreshing'
              : 'settings.modules.refresh',
          )}
        >
          <RefreshCw
            className={`yolo-modules-refresh-icon ${
              isLoading ? 'is-spinning' : ''
            }`}
            aria-hidden="true"
          />
          <span>{t('settings.modules.refresh')}</span>
        </button>
      </header>

      {isLoading ? (
        <div className="yolo-modules-state" role="status" aria-live="polite">
          <LoaderCircle
            className="yolo-modules-state-icon is-spinning"
            aria-hidden="true"
          />
          <p className="yolo-modules-state-message">
            {t('settings.modules.loading')}
          </p>
        </div>
      ) : snapshot.modules.length === 0 ? (
        snapshot.status === 'error' ? (
          <ModuleErrorState snapshot={snapshot} />
        ) : (
          <div className="yolo-modules-state" role="status">
            <PackageOpen
              className="yolo-modules-state-icon"
              aria-hidden="true"
            />
            <p className="yolo-modules-state-message">
              {t('settings.modules.empty')}
            </p>
          </div>
        )
      ) : (
        <>
          {snapshot.status === 'error' && (
            <ModuleErrorState snapshot={snapshot} compact />
          )}
          <div className="yolo-modules-groups">
            <ModuleGroup
              title={t('settings.modules.installed')}
              description={t('settings.modules.installedDescription')}
              emptyMessage={t('settings.modules.installedEmpty')}
              modules={installed}
              operationModuleId={operationModuleId}
              onInstall={openInstallConfirmation}
            />
            <ModuleGroup
              title={t('settings.modules.available')}
              description={t('settings.modules.availableDescription')}
              emptyMessage={t('settings.modules.availableEmpty')}
              modules={available}
              operationModuleId={operationModuleId}
              onInstall={openInstallConfirmation}
            />
          </div>
        </>
      )}
    </div>
  )
}
