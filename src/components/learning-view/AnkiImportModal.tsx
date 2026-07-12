import { AlertTriangle, FileArchive, Loader2, Upload, X } from 'lucide-react'
import { normalizePath } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import {
  commitAnkiImportPlan,
  prepareAnkiImport,
  renameAnkiImportPlan,
} from '../../core/learning/anki/importService'
import type { AnkiImportPlan } from '../../core/learning/anki/importService'
import { AnkiSqliteRuntimeManager } from '../../core/learning/anki/runtime/AnkiSqliteRuntimeManager'

import {
  formatByteSize,
  summarizeAnkiImport,
  validateAnkiImportFiles,
} from './ankiImportUtils'

type ImportState =
  | 'selecting'
  | 'runtime'
  | 'parsing'
  | 'preview'
  | 'importing'
  | 'error'

type ErrorAction = 'retry' | 'reselect'

export function AnkiImportModal({
  baseDir,
  onClose,
  onImported,
}: {
  baseDir: string
  onClose: () => void
  onImported: (projectPath: string) => void | Promise<void>
}) {
  const app = useApp()
  const plugin = usePlugin()
  const { t } = useLanguage()
  const [state, setState] = useState<ImportState>('selecting')
  const [file, setFile] = useState<File | null>(null)
  const [plan, setPlan] = useState<AnkiImportPlan | null>(null)
  const [projectName, setProjectName] = useState('')
  const [error, setError] = useState('')
  const [errorAction, setErrorAction] = useState<ErrorAction>('reselect')
  const chooseButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const abortCurrent = () => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state !== 'importing') {
        abortCurrent()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      abortCurrent()
    }
  }, [onClose, state])

  const showError = (message: string, action: ErrorAction) => {
    setError(message)
    setErrorAction(action)
    setState('error')
  }

  const parseFile = async (selected: File) => {
    abortCurrent()
    const controller = new AbortController()
    abortRef.current = controller
    setFile(selected)
    setPlan(null)
    setError('')
    try {
      const runtime = new AnkiSqliteRuntimeManager({
        app,
        pluginId: plugin.manifest.id,
        pluginDir: plugin.manifest.dir
          ? normalizePath(plugin.manifest.dir)
          : undefined,
      })
      const status = await runtime.getStatus()
      if (controller.signal.aborted) return
      setState(status.kind === 'ready' ? 'parsing' : 'runtime')
      const [packageBytes, wasm] = await Promise.all([
        selected.arrayBuffer(),
        runtime.loadWasm(),
      ])
      if (controller.signal.aborted) return
      setState('parsing')
      const nextPlan = await prepareAnkiImport({
        app,
        baseDir,
        packageBytes,
        wasmBytes: wasm.buffer.slice(
          wasm.byteOffset,
          wasm.byteOffset + wasm.byteLength,
        ),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setPlan(nextPlan)
      setProjectName(nextPlan.projectName)
      setState('preview')
    } catch (cause) {
      if (controller.signal.aborted) return
      const detail = cause instanceof Error ? cause.message : String(cause)
      showError(
        `${t('learning.anki.parseFailed', 'Could not read this APKG')}: ${detail}`,
        'retry',
      )
    }
  }

  const selectFiles = (files: readonly File[]) => {
    const validation = validateAnkiImportFiles(files)
    if (validation) {
      showError(
        t(`learning.anki.fileErrors.${validation}`, validation),
        'reselect',
      )
      return
    }
    void parseFile(files[0])
  }

  const importPlan = async () => {
    if (!plan) return
    const name = projectName.trim()
    if (!name) {
      showError(
        t(
          'learning.anki.nameRequired',
          'Enter a project name before importing.',
        ),
        'retry',
      )
      return
    }
    abortCurrent()
    const controller = new AbortController()
    abortRef.current = controller
    setState('importing')
    try {
      const listing = (await app.vault.adapter.exists(baseDir))
        ? await app.vault.adapter.list(baseDir)
        : { files: [], folders: [] }
      const existingSlugs = listing.folders.map(
        (path) => path.split('/').at(-1) ?? '',
      )
      const renamed = renameAnkiImportPlan({
        plan,
        projectName: name,
        existingProjectSlugs: existingSlugs,
      })
      const projectPath = await commitAnkiImportPlan({
        app,
        plan: renamed,
        srsStore: plugin.getLearningSrsStore(),
        signal: controller.signal,
      })
      onClose()
      void Promise.resolve(onImported(projectPath)).catch((navigationError) => {
        console.error(
          '[YOLO] Imported Anki project but failed to open it:',
          navigationError,
        )
      })
    } catch (cause) {
      if (controller.signal.aborted) return
      const detail = cause instanceof Error ? cause.message : String(cause)
      showError(
        `${t('learning.anki.importFailed', 'Import did not complete')}: ${detail}`,
        'retry',
      )
    }
  }

  const reselect = () => {
    abortCurrent()
    setFile(null)
    setPlan(null)
    setError('')
    setState('selecting')
    window.setTimeout(() => chooseButtonRef.current?.focus(), 0)
  }

  const summary = plan ? summarizeAnkiImport(plan) : null
  const busy =
    state === 'runtime' || state === 'parsing' || state === 'importing'

  return (
    <div className="yolo-anki-import-overlay" role="presentation">
      <section
        className="yolo-anki-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="yolo-anki-import-title"
      >
        <header className="yolo-anki-import-header">
          <div>
            <h2 id="yolo-anki-import-title">
              {t('learning.anki.title', 'Import from Anki')}
            </h2>
            <p>
              {t(
                'learning.anki.subtitle',
                'Preview an APKG before adding it to Learning Center.',
              )}
            </p>
          </div>
          <button
            type="button"
            className="yolo-anki-import-close"
            disabled={state === 'importing'}
            title={t('learning.anki.close', 'Close')}
            aria-label={t('learning.anki.close', 'Close')}
            onClick={() => {
              abortCurrent()
              onClose()
            }}
          >
            <X size={17} aria-hidden />
          </button>
        </header>

        <div className="yolo-anki-import-body" aria-live="polite">
          {state === 'selecting' && (
            <button
              ref={chooseButtonRef}
              type="button"
              className="yolo-anki-import-dropzone"
              autoFocus
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload size={22} aria-hidden />
              <strong>
                {t('learning.anki.chooseFile', 'Choose one .apkg file')}
              </strong>
              <span>
                {t('learning.anki.fileLimit', 'Maximum file size: 200 MB')}
              </span>
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".apkg"
            className="yolo-anki-import-file-input"
            aria-label={t('learning.anki.chooseFile', 'Choose one .apkg file')}
            onChange={(event) =>
              selectFiles(Array.from(event.currentTarget.files ?? []))
            }
          />

          {busy && (
            <div className="yolo-anki-import-progress">
              <Loader2 size={22} aria-hidden />
              <strong>
                {state === 'runtime'
                  ? t(
                      'learning.anki.preparingRuntime',
                      'Preparing the Anki parser...',
                    )
                  : state === 'parsing'
                    ? t(
                        'learning.anki.parsing',
                        'Reading cards and review history...',
                      )
                    : t(
                        'learning.anki.importing',
                        'Writing the learning project...',
                      )}
              </strong>
              {file && <span>{file.name}</span>}
            </div>
          )}

          {state === 'error' && (
            <div className="yolo-anki-import-error" role="alert">
              <AlertTriangle size={20} aria-hidden />
              <div>
                <strong>
                  {t('learning.anki.errorTitle', 'Anki import stopped')}
                </strong>
                <p>{error}</p>
              </div>
            </div>
          )}

          {state === 'preview' && plan && summary && (
            <div className="yolo-anki-import-preview">
              <label className="yolo-anki-import-name">
                <span>{t('learning.anki.projectName', 'Project name')}</span>
                <input
                  value={projectName}
                  onChange={(event) =>
                    setProjectName(event.currentTarget.value)
                  }
                  autoFocus
                />
              </label>
              <div className="yolo-anki-import-summary">
                <PreviewStat
                  label={t('learning.anki.chapters', 'Chapters')}
                  value={summary.chapterCount}
                />
                <PreviewStat
                  label={t('learning.anki.cards', 'Cards')}
                  value={summary.cardCount}
                />
                <PreviewStat
                  label={t('learning.anki.history', 'Cards with valid history')}
                  value={summary.historyCount}
                />
                <PreviewStat
                  label={t('learning.anki.suspended', 'Suspended')}
                  value={summary.suspendedCount}
                />
                <PreviewStat
                  label={t('learning.anki.media', 'Media')}
                  value={`${summary.mediaCount} · ${formatByteSize(summary.mediaBytes)}`}
                />
                <PreviewStat
                  label={t('learning.anki.skipped', 'Warnings / skipped')}
                  value={summary.warningCount}
                />
              </div>
              <section className="yolo-anki-import-section">
                <h3>{t('learning.anki.chapterPaths', 'Chapter paths')}</h3>
                <ul>
                  {summary.chapterPaths.map((path) => (
                    <li key={path}>
                      <FileArchive size={14} aria-hidden />
                      {path}
                    </li>
                  ))}
                </ul>
              </section>
              <section className="yolo-anki-import-section">
                <h3>
                  {t('learning.anki.warnings', 'Warnings and skipped items')}
                </h3>
                {plan.warnings.length ? (
                  <ul>
                    {plan.warnings.map((warning, index) => (
                      <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                  </ul>
                ) : (
                  <p>
                    {t(
                      'learning.anki.noWarnings',
                      'No warnings or skipped items were reported.',
                    )}
                  </p>
                )}
              </section>
            </div>
          )}
        </div>

        <footer className="yolo-anki-import-footer">
          {(state === 'preview' || state === 'error') && (
            <button
              type="button"
              className="yolo-anki-import-secondary"
              onClick={reselect}
            >
              {t('learning.anki.chooseAnother', 'Choose another file')}
            </button>
          )}
          {state === 'error' && errorAction === 'retry' && file && (
            <button
              type="button"
              className="yolo-anki-import-primary"
              onClick={() => (plan ? void importPlan() : void parseFile(file))}
            >
              {t('learning.anki.retry', 'Retry')}
            </button>
          )}
          {state === 'preview' && (
            <button
              type="button"
              className="yolo-anki-import-primary"
              onClick={() => void importPlan()}
            >
              {t('learning.anki.import', 'Import project')}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

function PreviewStat({
  label,
  value,
}: {
  label: string
  value: string | number
}) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}
