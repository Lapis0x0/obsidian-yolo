import {
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import { App, Notice } from 'obsidian'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

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

type ModuleAction = 'install' | 'update' | 'apply' | 'reload'

const INSTALLED_STATUSES = new Set<ModuleRecord['status']>([
  'installed',
  'active',
  'disabled',
  'update-available',
  'ready-to-apply',
  'activation-pending',
  'failed',
])

function ModuleCard({
  module,
  operationModuleId,
  onAction,
}: {
  module: ModuleRecord
  operationModuleId: string | null
  onAction: (module: ModuleRecord, action: ModuleAction) => void
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
    'ready-to-apply': t('settings.modules.statuses.readyToApply'),
    'activation-pending': t('settings.modules.statuses.activationPending'),
    failed: t('settings.modules.statuses.failed'),
  }
  const action: ModuleAction | undefined =
    module.status === 'available'
      ? 'install'
      : module.status === 'update-available'
        ? 'update'
        : module.status === 'ready-to-apply'
          ? 'apply'
          : module.status === 'activation-pending'
            ? 'reload'
            : undefined
  const transitionVersion =
    module.pendingVersion ?? module.candidateVersion ?? module.version
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
        {(module.status === 'ready-to-apply' ||
          module.status === 'activation-pending') && (
          <p
            className="yolo-module-card-transition-detail"
            role="status"
            aria-live="polite"
          >
            {t(
              module.status === 'ready-to-apply'
                ? 'settings.modules.readyToApplyDetail'
                : 'settings.modules.activationPendingDetail',
            ).replace('{version}', transitionVersion)}
          </p>
        )}
      </div>
      <div className="yolo-module-card-actions">
        {action && (
          <button
            type="button"
            className="yolo-module-card-action"
            onClick={() => onAction(module, action)}
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
                    : action === 'install'
                      ? 'settings.modules.installing'
                      : action === 'apply'
                        ? 'settings.modules.preparing'
                        : 'settings.modules.reloading'
                  : action === 'update'
                    ? 'settings.modules.update'
                    : action === 'install'
                      ? 'settings.modules.install'
                      : action === 'apply'
                        ? 'settings.modules.applyAndReload'
                        : 'settings.modules.reload',
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
  onAction,
  title,
}: {
  description: string
  emptyMessage: string
  modules: ReadonlyArray<ModuleRecord>
  operationModuleId: string | null
  onAction: (module: ModuleRecord, action: ModuleAction) => void
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
              onAction={onAction}
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
  const mountedRef = useRef(true)
  const operationGenerationRef = useRef(0)
  const confirmationModalRef = useRef<ConfirmModal | null>(null)
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

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationGenerationRef.current += 1
      const modal = confirmationModalRef.current
      confirmationModalRef.current = null
      modal?.close()
    }
  }, [])

  const clearOperation = (moduleId: string) => {
    if (!mountedRef.current) return
    setOperationModuleId((current) => (current === moduleId ? null : current))
  }

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
      clearOperation(module.id)
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
    const generation = ++operationGenerationRef.current
    setOperationModuleId(module.id)
    const modal = new ConfirmModal(app, {
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
        if (
          !mountedRef.current ||
          generation !== operationGenerationRef.current
        ) {
          return
        }
        confirmationModalRef.current = null
        void installCandidate(module, candidate, isUpdate)
      },
      onCancel: () => {
        if (generation !== operationGenerationRef.current) return
        confirmationModalRef.current = null
        clearOperation(module.id)
      },
    })
    confirmationModalRef.current = modal
    modal.open()
  }

  const prepareTransition = async (
    module: ModuleRecord,
    candidate: ConfirmedModuleCandidate,
  ) => {
    const name = module.catalog?.name ?? module.id
    try {
      await plugin.prepareConfirmedModuleTransition(candidate)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        t('settings.modules.applyError')
          .replace('{name}', name)
          .replace('{error}', message),
        8000,
      )
      clearOperation(module.id)
      return
    }

    try {
      window.location.reload()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        t('settings.modules.reloadError')
          .replace('{name}', name)
          .replace('{version}', candidate.expectedVersion)
          .replace('{error}', message),
        8000,
      )
    } finally {
      clearOperation(module.id)
    }
  }

  const openApplyConfirmation = async (module: ModuleRecord) => {
    const name = module.catalog?.name ?? module.id
    const generation = ++operationGenerationRef.current
    setOperationModuleId(module.id)
    let candidate: ConfirmedModuleCandidate | undefined
    try {
      candidate = await plugin.getModuleTransitionCandidate(module.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        t('settings.modules.applyError')
          .replace('{name}', name)
          .replace('{error}', message),
        8000,
      )
      clearOperation(module.id)
      return
    }
    if (!mountedRef.current || generation !== operationGenerationRef.current) {
      return
    }
    if (
      !candidate ||
      !module.candidateVersion ||
      candidate.expectedVersion !== module.candidateVersion
    ) {
      new Notice(
        t('settings.modules.transitionCandidateUnavailable').replace(
          '{name}',
          name,
        ),
      )
      clearOperation(module.id)
      return
    }

    const catalogWarning = snapshot.errors.catalog
      ? t('settings.modules.applyCatalogUnavailableWarning')
      : !module.catalog
        ? t('settings.modules.applyWithdrawnWarning')
        : ''
    const modal = new ConfirmModal(app, {
      title: t('settings.modules.confirmApplyTitle').replace('{name}', name),
      message: `${t('settings.modules.confirmApplyMessage')
        .replace('{name}', name)
        .replace('{version}', candidate.expectedVersion)
        .replace('{sha256}', candidate.expectedManifestSha256)}${
        catalogWarning ? `\n\n${catalogWarning}` : ''
      }`,
      ctaText: t('settings.modules.applyAndReload'),
      onConfirm: () => {
        if (
          !mountedRef.current ||
          generation !== operationGenerationRef.current
        ) {
          return
        }
        confirmationModalRef.current = null
        void prepareTransition(module, candidate)
      },
      onCancel: () => {
        if (generation !== operationGenerationRef.current) return
        confirmationModalRef.current = null
        clearOperation(module.id)
      },
    })
    confirmationModalRef.current = modal
    modal.open()
  }

  const reloadPreparedTransition = (module: ModuleRecord) => {
    const name = module.catalog?.name ?? module.id
    const version =
      module.pendingVersion ?? module.candidateVersion ?? module.version
    setOperationModuleId(module.id)
    try {
      window.location.reload()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      new Notice(
        t('settings.modules.reloadError')
          .replace('{name}', name)
          .replace('{version}', version)
          .replace('{error}', message),
        8000,
      )
    } finally {
      clearOperation(module.id)
    }
  }

  const handleAction = (module: ModuleRecord, action: ModuleAction) => {
    if (action === 'install' || action === 'update') {
      openInstallConfirmation(module)
      return
    }
    if (action === 'apply') {
      void openApplyConfirmation(module)
      return
    }
    reloadPreparedTransition(module)
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
              onAction={handleAction}
            />
            <ModuleGroup
              title={t('settings.modules.available')}
              description={t('settings.modules.availableDescription')}
              emptyMessage={t('settings.modules.availableEmpty')}
              modules={available}
              operationModuleId={operationModuleId}
              onAction={handleAction}
            />
          </div>
        </>
      )}
    </div>
  )
}
