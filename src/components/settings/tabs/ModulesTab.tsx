import { LoaderCircle, PackageOpen, TriangleAlert } from 'lucide-react'
import { Notice, setIcon } from 'obsidian'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type {
  ConfirmedModuleCandidate,
  ModuleManagerSnapshot,
  ModuleRecord,
} from '../../../core/modules'
import {
  type ModuleFailure,
  describeModuleFailure,
} from '../../../core/modules/moduleFailure'
import { compareModuleVersions } from '../../../core/modules/moduleManager'
import type {
  ModuleOperationResult,
  ModuleService,
} from '../../../core/modules/moduleService'
import type { RegisteredModuleSettingsContributionV1 } from '../../../core/modules/moduleSettingsContributions'
import { ModuleSettingsSection } from '../sections/ModuleSettingsSection'

type ModulesTabProps = {
  service: ModuleService
  registrations: readonly RegisteredModuleSettingsContributionV1[]
}

export type ModuleProductAction = 'install' | 'enable' | 'disable' | 'uninstall'
export type ModuleShelfAction =
  | ModuleProductAction
  | 'settings'
  | 'update'
  | 'update-enable'
  | 'reload'

type OperationState = Readonly<{
  action: ModuleShelfAction
  error?: string
  moduleId: string
}>

export type ModuleManagementView = 'loading' | 'error' | 'empty' | 'content'

export function getModuleManagementView(
  snapshot: Pick<ModuleManagerSnapshot, 'status' | 'modules'>,
): ModuleManagementView {
  if (snapshot.status === 'loading') return 'loading'
  if (snapshot.modules.length > 0) return 'content'
  return snapshot.status === 'error' ? 'error' : 'empty'
}

export function getRetryAction(
  operation: OperationState | null,
  moduleId: string,
): ModuleShelfAction | undefined {
  return operation?.moduleId === moduleId && operation.error
    ? operation.action
    : undefined
}

export function createFailedOperation(
  moduleId: string,
  action: ModuleShelfAction,
  error: string,
): OperationState {
  return Object.freeze({ moduleId, action, error })
}

export function formatModuleFailure(
  failure: ModuleFailure,
  t: (keyPath: string, fallback?: string) => string,
): string {
  const key =
    failure.kind === 'download-timeout' ? 'downloadTimeout' : failure.kind
  const summary = t(`settings.modules.failure.${key}`)
  return `${summary} ${t('settings.modules.failure.diagnostic').replace(
    '{detail}',
    failure.detail,
  )}`
}

export type ModuleSections = Readonly<{
  enabled: readonly ModuleRecord[]
  disabled: readonly ModuleRecord[]
  available: readonly ModuleRecord[]
}>

export function hasModuleUpdate(
  module: Pick<ModuleRecord, 'installed' | 'catalog'>,
): boolean {
  return Boolean(
    module.installed &&
      module.catalog &&
      compareModuleVersions(module.installed.version, module.catalog.version) <
        0,
  )
}

export function partitionModules(
  modules: readonly ModuleRecord[],
): ModuleSections {
  return Object.freeze({
    enabled: Object.freeze(modules.filter((module) => module.enabled === true)),
    disabled: Object.freeze(
      modules.filter(
        (module) => module.desiredInstalled === true && module.enabled !== true,
      ),
    ),
    available: Object.freeze(
      modules.filter((module) => module.desiredInstalled !== true),
    ),
  })
}

export function getModuleShelfActions(
  module: Pick<
    ModuleRecord,
    | 'enabled'
    | 'desiredInstalled'
    | 'installed'
    | 'catalog'
    | 'compatibilityIssues'
    | 'status'
  >,
  hasSettings = false,
): readonly ModuleShelfAction[] {
  const incompatible = (module.compatibilityIssues?.length ?? 0) > 0
  const update = hasModuleUpdate(module)
  if (module.desiredInstalled !== true) {
    return incompatible ? [] : ['install']
  }
  if (module.enabled === true) {
    const actions: ModuleShelfAction[] = []
    if (hasSettings) actions.push('settings')
    if (module.status === 'activation-pending') actions.push('reload')
    else if (module.status === 'failed' && !incompatible) actions.push('reload')
    else if (update && !incompatible) actions.push('update')
    actions.push('disable')
    return actions
  }
  return [
    ...(update && !incompatible
      ? (['update-enable'] as const)
      : !incompatible
        ? (['enable'] as const)
        : []),
    'uninstall',
  ]
}

export function projectModuleSettingsNavigation(
  modules: readonly ModuleRecord[],
  registrations: readonly RegisteredModuleSettingsContributionV1[],
): readonly Readonly<{
  module: ModuleRecord
  registrations: readonly RegisteredModuleSettingsContributionV1[]
  icon?: string
}>[] {
  const enabledById = new Map(
    modules
      .filter((module) => module.enabled === true)
      .map((module) => [module.id, module]),
  )
  const grouped = new Map<string, RegisteredModuleSettingsContributionV1[]>()
  for (const registration of registrations) {
    if (!enabledById.has(registration.moduleId)) continue
    const current = grouped.get(registration.moduleId) ?? []
    current.push(registration)
    grouped.set(registration.moduleId, current)
  }
  return Object.freeze(
    [...grouped].map(([moduleId, values]) =>
      Object.freeze({
        module: enabledById.get(moduleId)!,
        registrations: Object.freeze(values),
        icon: values.find(({ contribution }) => contribution.icon)?.contribution
          .icon,
      }),
    ),
  )
}

export async function executeModuleProductAction(
  service: Pick<ModuleService, 'install' | 'setEnabled' | 'uninstall'>,
  module: Pick<ModuleRecord, 'id'>,
  action: ModuleProductAction,
  confirmedInstallCandidate?: ConfirmedModuleCandidate,
): Promise<ModuleOperationResult> {
  if (action === 'install') {
    if (
      !confirmedInstallCandidate ||
      confirmedInstallCandidate.moduleId !== module.id
    ) {
      throw new Error(
        `No matching install candidate is available for ${module.id}`,
      )
    }
    return service.install(confirmedInstallCandidate)
  }
  if (action === 'enable' || action === 'disable') {
    return service.setEnabled(module.id, action === 'enable')
  }
  return service.uninstall(module.id)
}

export function ModulesTab({ service, registrations }: ModulesTabProps) {
  const { t } = useLanguage()
  const snapshot = useSyncExternalStore(
    service.subscribe,
    service.getSnapshot,
    service.getSnapshot,
  )
  const navigation = projectModuleSettingsNavigation(
    snapshot.modules,
    registrations,
  )
  const [selectedModuleId, setSelectedModuleId] = useState<string | null>(null)
  const [operation, setOperation] = useState<OperationState | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    if (
      selectedModuleId &&
      !navigation.some(({ module }) => module.id === selectedModuleId)
    ) {
      setSelectedModuleId(null)
    }
  }, [navigation, selectedModuleId])

  const selected = navigation.find(
    ({ module }) => module.id === selectedModuleId,
  )
  const settingsIconsByModuleId = new Map(
    navigation.map(({ module, icon }) => [module.id, icon]),
  )
  const sections = partitionModules(snapshot.modules)
  const busy = Boolean(operation && !operation.error)

  const clearOperation = (moduleId: string) => {
    if (!mounted.current) return
    setOperation((current) => (current?.moduleId === moduleId ? null : current))
  }

  const runAction = async (
    module: ModuleRecord,
    action: ModuleProductAction,
    candidate?: ConfirmedModuleCandidate,
    displayAction: ModuleShelfAction = action,
  ) => {
    setOperation({ action: displayAction, moduleId: module.id })
    try {
      await executeModuleProductAction(service, module, action, candidate)
      clearOperation(module.id)
    } catch (error) {
      if (!mounted.current) return
      setOperation(
        createFailedOperation(
          module.id,
          displayAction,
          t('settings.modules.actionError')
            .replace('{name}', module.name)
            .replace(
              '{error}',
              formatModuleFailure(describeModuleFailure(error), t),
            ),
        ),
      )
    }
  }

  const installModule = (module: ModuleRecord) => {
    const candidate = service.getInstallCandidate(module.id)
    const isUpdate = hasModuleUpdate(module)
    if (!candidate || candidate.expectedVersion !== module.catalog?.version) {
      new Notice(
        t('settings.modules.candidateUnavailable').replace(
          '{name}',
          module.name,
        ),
      )
      return
    }
    void runAction(
      module,
      'install',
      candidate,
      isUpdate && module.enabled !== true
        ? 'update-enable'
        : isUpdate
          ? 'update'
          : 'install',
    )
  }

  const handleAction = (module: ModuleRecord, action: ModuleShelfAction) => {
    if (action === 'settings') {
      setSelectedModuleId(module.id)
      return
    }
    if (
      action === 'install' ||
      action === 'update' ||
      action === 'update-enable'
    ) {
      installModule(module)
      return
    }
    if (action === 'uninstall') {
      void runAction(module, 'uninstall')
      return
    }
    void runAction(
      module,
      action === 'disable' ? 'disable' : 'enable',
      undefined,
      action,
    )
  }

  return (
    <div className="yolo-settings-section yolo-modules-page">
      <div className="yolo-settings-header">{t('settings.modules.title')}</div>
      <div className="yolo-settings-desc yolo-modules-intro">
        {t('settings.modules.description')}
      </div>
      <div className="yolo-module-shelf">
        <nav className="yolo-module-shelf-rail">
          <button
            type="button"
            className={`yolo-module-shelf-nav ${selectedModuleId === null ? 'is-active' : ''}`}
            aria-current={selectedModuleId === null ? 'page' : undefined}
            onClick={() => setSelectedModuleId(null)}
          >
            <span className="yolo-module-shelf-nav-label">
              {t('settings.modules.manage')}
            </span>
          </button>
          {navigation.length > 0 ? (
            <div className="yolo-module-shelf-divider" />
          ) : null}
          {navigation.map(({ module }) => (
            <button
              key={module.id}
              type="button"
              className={`yolo-module-shelf-nav ${selectedModuleId === module.id ? 'is-active' : ''}`}
              aria-current={selectedModuleId === module.id ? 'page' : undefined}
              onClick={() => setSelectedModuleId(module.id)}
            >
              <span className="yolo-module-shelf-nav-label">{module.name}</span>
            </button>
          ))}
        </nav>
        <main className="yolo-module-shelf-canvas">
          {selected ? (
            <ModuleSettingsPanel registrations={selected.registrations} />
          ) : (
            <ModuleManagementPanel
              snapshot={snapshot}
              sections={sections}
              operation={operation}
              settingsIconsByModuleId={settingsIconsByModuleId}
              busy={busy}
              onAction={handleAction}
              onRetry={() => void service.refresh()}
            />
          )}
        </main>
      </div>
    </div>
  )
}

function ModuleManagementPanel({
  snapshot,
  sections,
  operation,
  settingsIconsByModuleId,
  busy,
  onAction,
  onRetry,
}: {
  snapshot: ModuleManagerSnapshot
  sections: ModuleSections
  operation: OperationState | null
  settingsIconsByModuleId: ReadonlyMap<string, string | undefined>
  busy: boolean
  onAction: (module: ModuleRecord, action: ModuleShelfAction) => void
  onRetry: () => void
}) {
  const { t } = useLanguage()
  const view = getModuleManagementView(snapshot)
  return (
    <section className="yolo-module-shelf-panel">
      <header className="yolo-module-shelf-header">
        <div>
          <h2>{t('settings.modules.manage')}</h2>
          <p>{t('settings.modules.manageDescription')}</p>
        </div>
      </header>
      {view === 'loading' ? (
        <ModuleState
          icon={<LoaderCircle className="is-spinning" />}
          message={t('settings.modules.loading')}
        />
      ) : view === 'error' ? (
        <ModuleError snapshot={snapshot} onRetry={onRetry} />
      ) : view === 'empty' ? (
        <ModuleState
          icon={<PackageOpen />}
          message={t('settings.modules.empty')}
        />
      ) : (
        <>
          {snapshot.status === 'error' ? (
            <ModuleError compact snapshot={snapshot} onRetry={onRetry} />
          ) : null}
          <div className="yolo-module-shelf-groups">
            <ModuleGroup
              title={t('settings.modules.enabled')}
              modules={sections.enabled}
              empty={t('settings.modules.enabledEmpty')}
              operation={operation}
              settingsIconsByModuleId={settingsIconsByModuleId}
              busy={busy}
              onAction={onAction}
            />
            {sections.disabled.length > 0 ? (
              <ModuleGroup
                title={t('settings.modules.disabled')}
                modules={sections.disabled}
                empty={t('settings.modules.disabledEmpty')}
                operation={operation}
                settingsIconsByModuleId={settingsIconsByModuleId}
                busy={busy}
                onAction={onAction}
              />
            ) : null}
            <ModuleGroup
              title={t('settings.modules.available')}
              modules={sections.available}
              empty={t('settings.modules.availableEmpty')}
              operation={operation}
              settingsIconsByModuleId={settingsIconsByModuleId}
              busy={busy}
              onAction={onAction}
            />
          </div>
        </>
      )}
    </section>
  )
}

function ModuleGroup({
  title,
  modules,
  empty,
  ...rowProps
}: {
  title: string
  modules: readonly ModuleRecord[]
  empty: string
  operation: OperationState | null
  settingsIconsByModuleId: ReadonlyMap<string, string | undefined>
  busy: boolean
  onAction: (module: ModuleRecord, action: ModuleShelfAction) => void
}) {
  return (
    <section className="yolo-module-shelf-group">
      <h3>{title}</h3>
      {modules.length > 0 ? (
        <div className="yolo-module-shelf-list">
          {modules.map((module) => (
            <ModuleRow key={module.id} module={module} {...rowProps} />
          ))}
        </div>
      ) : (
        <p className="yolo-module-shelf-empty">{empty}</p>
      )}
    </section>
  )
}

function ModuleRow({
  module,
  operation,
  settingsIconsByModuleId,
  busy,
  onAction,
}: {
  module: ModuleRecord
  operation: OperationState | null
  settingsIconsByModuleId: ReadonlyMap<string, string | undefined>
  busy: boolean
  onAction: (module: ModuleRecord, action: ModuleShelfAction) => void
}) {
  const { t } = useLanguage()
  const actions = getModuleShelfActions(
    module,
    settingsIconsByModuleId.has(module.id),
  )
  const updating = hasModuleUpdate(module)
  const visibleActions = actions.filter(
    (action) => action !== 'settings' && action !== 'uninstall',
  )
  const canUninstall = actions.includes('uninstall')
  const hasOperationError = Boolean(
    operation?.moduleId === module.id && operation.error,
  )
  const currentVersion =
    module.installed?.version ?? module.catalog?.version ?? module.version

  return (
    <article className="yolo-module-shelf-row" data-module-id={module.id}>
      <ModuleGlyph
        moduleId={module.id}
        icon={module.catalog?.icon ?? settingsIconsByModuleId.get(module.id)}
      />
      <div className="yolo-module-shelf-row-copy">
        <div className="yolo-module-shelf-row-heading">
          <strong>{module.name}</strong>
          <span
            className={`yolo-module-shelf-version ${updating ? 'is-update' : ''}`}
          >
            v{currentVersion}
            {updating ? ` → v${module.catalog?.version ?? ''}` : ''}
          </span>
        </div>
        <p>{module.description}</p>
        {module.error && !hasOperationError ? (
          <span className="yolo-module-shelf-error" role="alert">
            {formatModuleFailure(
              module.failure ?? describeModuleFailure(module.error),
              t,
            )}
          </span>
        ) : null}
        {(module.compatibilityIssues?.length ?? 0) > 0 ? (
          <span className="yolo-module-shelf-error" role="alert">
            {t('settings.modules.incompatibleReason').replace(
              '{reason}',
              module
                .compatibilityIssues!.map((issue) =>
                  t(`settings.modules.compatibility.${issue.kind}`),
                )
                .join(', '),
            )}
          </span>
        ) : null}
        <ModuleOperationError
          module={module}
          operation={operation}
          onRetry={onAction}
        />
      </div>
      <div className="yolo-module-shelf-actions">
        {visibleActions.map((action) => (
          <button
            key={action}
            type="button"
            className={`yolo-module-shelf-action ${action === 'install' || action === 'enable' || action.startsWith('update') ? 'mod-cta' : ''}`}
            disabled={busy}
            aria-busy={
              operation?.moduleId === module.id && !operation.error
                ? true
                : undefined
            }
            onClick={() => onAction(module, action)}
          >
            {operation?.moduleId === module.id &&
            operation.action === action &&
            !operation.error ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : null}
            {actionLabel(action, t)}
          </button>
        ))}
        {canUninstall ? (
          <button
            type="button"
            className="yolo-module-shelf-action yolo-module-shelf-uninstall"
            disabled={busy}
            aria-busy={
              operation?.moduleId === module.id &&
              operation.action === 'uninstall' &&
              !operation.error
                ? true
                : undefined
            }
            onClick={() => onAction(module, 'uninstall')}
          >
            {operation?.moduleId === module.id &&
            operation.action === 'uninstall' &&
            !operation.error ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : null}
            {actionLabel('uninstall', t)}
          </button>
        ) : null}
      </div>
    </article>
  )
}

function ModuleSettingsPanel({
  registrations,
}: {
  registrations: readonly RegisteredModuleSettingsContributionV1[]
}) {
  return (
    <section className="yolo-module-shelf-panel">
      <ModuleSettingsSection registrations={registrations} />
    </section>
  )
}

function ModuleGlyph({
  moduleId,
  icon = 'package',
}: {
  moduleId: string
  icon?: string
}) {
  const ref = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    if (ref.current) setIcon(ref.current, icon)
  }, [icon])
  return (
    <span
      ref={ref}
      className="yolo-module-shelf-glyph"
      data-module-id={moduleId}
      aria-hidden="true"
    />
  )
}

function ModuleState({
  icon,
  message,
}: {
  icon: React.ReactNode
  message: string
}) {
  return (
    <div className="yolo-modules-state" role="status">
      {icon}
      <p>{message}</p>
    </div>
  )
}

function ModuleOperationError({
  module,
  operation,
  onRetry,
}: {
  module: ModuleRecord
  operation: OperationState | null
  onRetry: (module: ModuleRecord, action: ModuleShelfAction) => void
}) {
  const { t } = useLanguage()
  const retryAction = getRetryAction(operation, module.id)
  if (!retryAction || !operation?.error) return null
  return (
    <span className="yolo-module-shelf-error" role="alert">
      <span>{operation.error}</span>
      <button type="button" onClick={() => onRetry(module, retryAction)}>
        {t('settings.modules.retry')}
      </button>
    </span>
  )
}

function ModuleError({
  snapshot,
  onRetry,
  compact = false,
}: {
  snapshot: ModuleManagerSnapshot
  onRetry: () => void
  compact?: boolean
}) {
  const { t } = useLanguage()
  const details = [
    snapshot.errors.catalog,
    snapshot.errors.installed,
    snapshot.errors.intent,
  ].filter(Boolean)
  return (
    <div
      className={`yolo-modules-state yolo-modules-state--error ${compact ? 'yolo-modules-state--compact' : ''}`}
      role="alert"
    >
      <TriangleAlert aria-hidden="true" />
      <div>
        <p>{t('settings.modules.loadError')}</p>
        {details.map((detail) => (
          <p key={detail}>{detail}</p>
        ))}
      </div>
      <button type="button" onClick={onRetry}>
        {t('settings.modules.retry')}
      </button>
    </div>
  )
}

function actionLabel(
  action: ModuleShelfAction,
  t: (key: string) => string,
): string {
  if (action === 'settings') return t('settings.modules.settings')
  if (action === 'update') return t('settings.modules.update')
  if (action === 'update-enable') return t('settings.modules.updateAndEnable')
  if (action === 'reload') return t('settings.modules.reload')
  return t(`settings.modules.actions.${action}`)
}
