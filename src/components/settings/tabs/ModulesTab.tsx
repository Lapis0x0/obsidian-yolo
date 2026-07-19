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
import type YoloPlugin from '../../../main'
import { ConfirmModal } from '../../modals/ConfirmModal'

type ModulesTabProps = {
  app: App
  plugin: YoloPlugin & Partial<ModuleProductCapabilities>
}

export type ModuleProductCapabilities = {
  hasModuleProductCapabilities?: () => boolean
  getModuleInstallCandidate: (
    moduleId: string,
  ) => ConfirmedModuleCandidate | undefined
  installConfirmedModuleCandidate: (
    candidate: ConfirmedModuleCandidate,
  ) => Promise<unknown>
  setModuleDesiredInstalled: (
    moduleId: string,
    desiredInstalled: boolean,
  ) => Promise<void>
  setModuleEnabled: (moduleId: string, enabled: boolean) => Promise<void>
  uninstallInactiveModule: (moduleId: string) => Promise<void>
  uninstallAndRemoveModuleData: (moduleId: string) => Promise<void>
}

export type ModuleProductAction = 'install' | 'enable' | 'disable' | 'uninstall'

export function requiresModuleProductConfirmation(
  action: ModuleProductAction,
): boolean {
  return action === 'install' || action === 'uninstall'
}

type ModuleAction =
  | ModuleProductAction
  | 'update'
  | 'apply'
  | 'reload'
  | 'remove-data'

type ProductModuleRecord = ModuleRecord

function moduleCompatibilityReason(
  module: ModuleRecord,
  t: (key: string) => string,
): string | undefined {
  const issues = module.compatibilityIssues
  if (!issues || issues.length === 0) return undefined
  return issues
    .map((issue) => t(`settings.modules.compatibility.${issue.kind}`))
    .join(', ')
}

function hasCompatibilityIssues(module: Pick<ModuleRecord, 'compatibilityIssues'>): boolean {
  return (module.compatibilityIssues?.length ?? 0) > 0
}

type OperationState = Readonly<{
  action: ModuleAction
  error?: string
  moduleId: string
}>

export function getModuleProductActions(
  module: Pick<
    ModuleRecord,
    'desiredInstalled' | 'enabled' | 'installed' | 'compatibilityIssues'
  >,
  productCapabilitiesAvailable = false,
): readonly ModuleProductAction[] {
  if (!productCapabilitiesAvailable) return []
  if (!module.installed) {
    return hasCompatibilityIssues(module) ? [] : ['install']
  }
  if (module.desiredInstalled === false) return ['uninstall']

  const actions: ModuleProductAction[] = []
  if (module.enabled === true) actions.push('disable')
  if (module.enabled === false && !hasCompatibilityIssues(module)) {
    actions.push('enable')
  }
  actions.push('uninstall')
  return actions
}

export function hasModuleProductCapabilities(
  capabilities: Partial<ModuleProductCapabilities>,
): boolean {
  return capabilities.hasModuleProductCapabilities?.() === true
}

function requireCapability<K extends keyof ModuleProductCapabilities>(
  capabilities: Partial<ModuleProductCapabilities>,
  name: K,
): ModuleProductCapabilities[K] {
  const capability = capabilities[name]
  if (typeof capability !== 'function') {
    throw new Error(`Module host capability is unavailable: ${name}`)
  }
  return capability.bind(capabilities) as ModuleProductCapabilities[K]
}

export async function executeModuleProductAction(
  capabilities: Partial<ModuleProductCapabilities>,
  module: Pick<
    ModuleRecord,
    'id' | 'installed' | 'status' | 'compatibilityIssues'
  >,
  action: ModuleProductAction,
  confirmedInstallCandidate?: ConfirmedModuleCandidate,
): Promise<Readonly<{ reloadRequired: boolean }>> {
  if (
    hasCompatibilityIssues(module) &&
    (action === 'install' || action === 'enable')
  ) {
    throw new Error(
      `Module ${module.id} is incompatible: ${module.compatibilityIssues
        ?.map((issue) => issue.kind)
        .join(', ')}`,
    )
  }
  if (!hasModuleProductCapabilities(capabilities)) {
    throw new Error('Module product capabilities are unavailable')
  }
  if (action === 'install') {
    if (
      !confirmedInstallCandidate ||
      confirmedInstallCandidate.moduleId !== module.id
    ) {
      throw new Error(
        `No confirmed install candidate is available for ${module.id}`,
      )
    }
    await requireCapability(capabilities, 'setModuleDesiredInstalled')(
      module.id,
      true,
    )
    await requireCapability(
      capabilities,
      'installConfirmedModuleCandidate',
    )(confirmedInstallCandidate)
    return { reloadRequired: false }
  }
  if (action === 'enable' || action === 'disable') {
    await requireCapability(capabilities, 'setModuleEnabled')(
      module.id,
      action === 'enable',
    )
    return { reloadRequired: true }
  }

  await requireCapability(capabilities, 'setModuleDesiredInstalled')(
    module.id,
    false,
  )
  if (module.installed?.active === true || module.status === 'active') {
    return { reloadRequired: true }
  }
  await requireCapability(capabilities, 'uninstallInactiveModule')(module.id)
  return { reloadRequired: false }
}

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
  operation,
  onAction,
  productCapabilitiesAvailable,
}: {
  module: ProductModuleRecord
  operation: OperationState | null
  onAction: (module: ModuleRecord, action: ModuleAction) => void
  productCapabilitiesAvailable: boolean
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
  const releaseAction: ModuleAction | undefined =
    module.status === 'update-available'
      ? 'update'
      : module.status === 'ready-to-apply'
        ? 'apply'
        : module.status === 'activation-pending'
          ? 'reload'
          : undefined
  const transitionVersion =
    module.pendingVersion ?? module.candidateVersion ?? module.version
  const productActions = getModuleProductActions(
    module,
    productCapabilitiesAvailable,
  )
  const incompatibilityReason = moduleCompatibilityReason(module, t)
  const isIncompatible = incompatibilityReason !== undefined
  const isOperating = operation?.moduleId === module.id && !operation.error
  const hasOperation = operation !== null && !operation.error
  const intentInstalled = module.desiredInstalled
  const intentEnabled = module.enabled
  const readiness = module.installed
    ? module.status === 'failed'
      ? 'failed'
      : 'ready'
    : intentInstalled
      ? 'pending'
      : 'notInstalled'

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
        {incompatibilityReason && (
          <p className="yolo-module-card-error" role="alert">
            {t('settings.modules.incompatibleReason').replace(
              '{reason}',
              incompatibilityReason,
            )}
          </p>
        )}
        <div className="yolo-module-card-state-row">
          <span className="yolo-module-card-state-label">
            {t('settings.modules.intentLabel')}
          </span>
          <span className="yolo-module-card-state-value">
            {t(
              intentInstalled === undefined
                ? 'settings.modules.intentUnknown'
                : intentInstalled
                  ? intentEnabled
                    ? 'settings.modules.intentInstalledEnabled'
                    : 'settings.modules.intentInstalledDisabled'
                  : 'settings.modules.intentUninstalled',
            )}
          </span>
          <span className="yolo-module-card-state-label">
            {t('settings.modules.readinessLabel')}
          </span>
          <span className="yolo-module-card-state-value">
            {t(`settings.modules.readiness.${readiness}`)}
          </span>
        </div>
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
        {operation?.moduleId === module.id && operation.error && (
          <div className="yolo-module-card-operation-error" role="alert">
            <span>{operation.error}</span>
            <button
              type="button"
              className="yolo-module-card-retry"
              onClick={() => onAction(module, operation.action)}
            >
              {t('settings.modules.retry')}
            </button>
          </div>
        )}
      </div>
      <div className="yolo-module-card-actions">
        {releaseAction && (
          <button
            type="button"
            className="yolo-module-card-action"
            onClick={() => onAction(module, releaseAction)}
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
                  ? releaseAction === 'update'
                    ? 'settings.modules.updating'
                    : releaseAction === 'apply'
                      ? 'settings.modules.preparing'
                      : 'settings.modules.reloading'
                  : releaseAction === 'update'
                    ? 'settings.modules.update'
                    : releaseAction === 'apply'
                      ? 'settings.modules.applyAndReload'
                      : 'settings.modules.reload',
              )}
            </span>
          </button>
        )}
        {productActions.map((action) => (
          <button
            key={action}
            type="button"
            className={`yolo-module-card-action yolo-module-card-action--${action}`}
            onClick={() => onAction(module, action)}
            disabled={hasOperation}
            aria-busy={isOperating || undefined}
          >
            {isOperating && operation?.action === action && (
              <LoaderCircle
                className="yolo-module-card-action-icon is-spinning"
                aria-hidden="true"
              />
            )}
            <span>
              {t(
                isOperating && operation?.action === action
                  ? `settings.modules.actions.${action}Busy`
                  : `settings.modules.actions.${action}`,
              )}
            </span>
          </button>
        ))}
        {productCapabilitiesAvailable &&
        module.id === 'learning' &&
        module.installed ? (
          <button
            type="button"
            className="yolo-module-card-action yolo-module-card-action--remove-data"
            onClick={() => onAction(module, 'remove-data')}
            disabled={hasOperation}
            aria-busy={
              isOperating && operation?.action === 'remove-data'
                ? true
                : undefined
            }
          >
            {isOperating && operation?.action === 'remove-data' ? (
              <LoaderCircle
                className="yolo-module-card-action-icon is-spinning"
                aria-hidden="true"
              />
            ) : null}
            <span>Uninstall and delete Learning data</span>
          </button>
        ) : null}
      </div>
    </article>
  )
}

function ModuleGroup({
  description,
  emptyMessage,
  modules,
  operation,
  onAction,
  productCapabilitiesAvailable,
  title,
}: {
  description: string
  emptyMessage: string
  modules: ReadonlyArray<ModuleRecord>
  operation: OperationState | null
  onAction: (module: ModuleRecord, action: ModuleAction) => void
  productCapabilitiesAvailable: boolean
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
              operation={operation}
              onAction={onAction}
              productCapabilitiesAvailable={productCapabilitiesAvailable}
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
    snapshot.errors.intent
      ? t('settings.modules.intentError').replace(
          '{error}',
          snapshot.errors.intent,
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
  const [operation, setOperation] = useState<OperationState | null>(null)
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
  const productCapabilitiesAvailable = hasModuleProductCapabilities(plugin)
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
    setOperation((current) => (current?.moduleId === moduleId ? null : current))
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
    setOperation({
      action: isUpdate ? 'update' : 'install',
      moduleId: module.id,
    })
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
    setOperation({ action: 'apply', moduleId: module.id })
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
    setOperation({ action: 'reload', moduleId: module.id })
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

  const runProductAction = async (
    module: ModuleRecord,
    action: ModuleProductAction,
    confirmedInstallCandidate?: ConfirmedModuleCandidate,
  ) => {
    const name = module.catalog?.name ?? module.id
    setOperation({ action, moduleId: module.id })
    try {
      const result = await executeModuleProductAction(
        plugin,
        module,
        action,
        confirmedInstallCandidate,
      )
      await manager.refresh()
      new Notice(
        t(
          result.reloadRequired
            ? 'settings.modules.actionReloadSuccess'
            : `settings.modules.actionSuccess.${action}`,
        ).replace('{name}', name),
        8000,
      )
      clearOperation(module.id)
    } catch (error) {
      if (!mountedRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setOperation({
        action,
        error: t('settings.modules.actionError')
          .replace('{name}', name)
          .replace('{error}', message),
        moduleId: module.id,
      })
    }
  }

  const openProductConfirmation = (
    module: ModuleRecord,
    action: 'install' | 'uninstall',
  ) => {
    const name = module.catalog?.name ?? module.id
    let confirmedInstallCandidate: ConfirmedModuleCandidate | undefined
    if (action === 'install') {
      const candidate = plugin.getModuleInstallCandidate(module.id)
      if (!candidate || candidate.moduleId !== module.id) {
        setOperation({
          action,
          error: t('settings.modules.actionError')
            .replace('{name}', name)
            .replace(
              '{error}',
              `No install candidate is available for ${module.id}`,
            ),
          moduleId: module.id,
        })
        return
      }
      confirmedInstallCandidate = {
        moduleId: candidate.moduleId,
        expectedVersion: candidate.expectedVersion,
        expectedManifestSha256: candidate.expectedManifestSha256,
      }
    }
    const generation = ++operationGenerationRef.current
    setOperation({ action, moduleId: module.id })
    const confirmationMessage = t(
      `settings.modules.confirmProduct.${action}Message`,
    ).replace('{name}', name)
    const modal = new ConfirmModal(app, {
      title: t(`settings.modules.confirmProduct.${action}Title`).replace(
        '{name}',
        name,
      ),
      message:
        action === 'install' && confirmedInstallCandidate
          ? `${confirmationMessage}\n\n${t('settings.modules.version').replace(
              '{version}',
              confirmedInstallCandidate.expectedVersion,
            )}`
          : confirmationMessage,
      ctaText: t(`settings.modules.actions.${action}`),
      onConfirm: () => {
        if (
          !mountedRef.current ||
          generation !== operationGenerationRef.current
        ) {
          return
        }
        confirmationModalRef.current = null
        void runProductAction(module, action, confirmedInstallCandidate)
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

  const runDataRemoval = async (module: ModuleRecord) => {
    const name = module.catalog?.name ?? module.id
    setOperation({ action: 'remove-data', moduleId: module.id })
    try {
      await requireCapability(plugin, 'uninstallAndRemoveModuleData')(module.id)
      await manager.refresh()
      new Notice(
        `${name} was uninstalled and its owned data was removed.`,
        8000,
      )
      clearOperation(module.id)
    } catch (error) {
      if (!mountedRef.current) return
      const message = error instanceof Error ? error.message : String(error)
      setOperation({
        action: 'remove-data',
        error: `Unable to remove ${name} data: ${message}`,
        moduleId: module.id,
      })
    }
  }

  const openDataRemovalConfirmation = (module: ModuleRecord) => {
    const name = module.catalog?.name ?? module.id
    const generation = ++operationGenerationRef.current
    setOperation({ action: 'remove-data', moduleId: module.id })
    const first = new ConfirmModal(app, {
      title: `Uninstall ${name} and delete data?`,
      message:
        'This is separate from normal uninstall. Learning project folders will be moved to trash; SRS state, Anki recovery journals, module settings, and private runtime data will be permanently deleted.',
      ctaText: 'Review permanent deletion',
      onConfirm: () => {
        if (
          !mountedRef.current ||
          generation !== operationGenerationRef.current
        ) {
          return
        }
        const second = new ConfirmModal(app, {
          title: 'Confirm permanent Learning data deletion',
          message:
            'This is the final confirmation. SRS state and Anki recovery data cannot be restored from Obsidian trash.',
          ctaText: 'Permanently delete owned data',
          onConfirm: () => {
            if (
              !mountedRef.current ||
              generation !== operationGenerationRef.current
            ) {
              return
            }
            confirmationModalRef.current = null
            void runDataRemoval(module)
          },
          onCancel: () => {
            if (generation !== operationGenerationRef.current) return
            confirmationModalRef.current = null
            clearOperation(module.id)
          },
        })
        confirmationModalRef.current = second
        second.open()
      },
      onCancel: () => {
        if (generation !== operationGenerationRef.current) return
        confirmationModalRef.current = null
        clearOperation(module.id)
      },
    })
    confirmationModalRef.current = first
    first.open()
  }

  const handleAction = (module: ModuleRecord, action: ModuleAction) => {
    if (action === 'remove-data') {
      openDataRemovalConfirmation(module)
      return
    }
    if (
      (action === 'install' || action === 'uninstall') &&
      requiresModuleProductConfirmation(action)
    ) {
      openProductConfirmation(module, action)
      return
    }
    if (action === 'enable' || action === 'disable') {
      void runProductAction(module, action)
      return
    }
    if (action === 'update') {
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
          disabled={isLoading || (operation !== null && !operation.error)}
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
              operation={operation}
              onAction={handleAction}
              productCapabilitiesAvailable={productCapabilitiesAvailable}
            />
            <ModuleGroup
              title={t('settings.modules.available')}
              description={t('settings.modules.availableDescription')}
              emptyMessage={t('settings.modules.availableEmpty')}
              modules={available}
              operation={operation}
              onAction={handleAction}
              productCapabilitiesAvailable={productCapabilitiesAvailable}
            />
          </div>
        </>
      )}
    </div>
  )
}
