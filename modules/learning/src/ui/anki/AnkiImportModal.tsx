import cx from 'clsx'
import { AlertTriangle, FileArchive, Loader2, Upload, X } from 'lucide-react'
import {
  type ReactNode,
  type Ref,
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'

import { type AnkiImportPlan, renameAnkiImportPlan } from '../../anki/import'

import {
  formatByteSize,
  summarizeAnkiImport,
  validateAnkiImportFiles,
} from './ankiImportUtils'

export type LearningTranslator = (key: string, fallback: string) => string

export type AnkiImportUiPort = {
  prepare(input: {
    file: File
    packageBytes: ArrayBuffer
    baseDir: string
    signal: AbortSignal
    onRuntimeReady: () => void
  }): Promise<AnkiImportPlan>
  commit(input: { plan: AnkiImportPlan; signal: AbortSignal }): Promise<string>
  listExistingProjectSlugs(baseDir: string): readonly string[]
}

type ImportState =
  | 'selecting'
  | 'runtime'
  | 'parsing'
  | 'preview'
  | 'importing'
  | 'error'

type ErrorAction = 'retry' | 'reselect'

const fallbackTranslator: LearningTranslator = (_key, fallback) => fallback

export function AnkiImportModal({
  baseDir,
  port,
  onClose,
  onImported,
  t = fallbackTranslator,
}: {
  baseDir: string
  port: AnkiImportUiPort
  onClose: () => void
  onImported: (projectPath: string) => void | Promise<void>
  t?: LearningTranslator
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const chooseButtonRef = useRef<HTMLButtonElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const [state, setState] = useState<ImportState>('selecting')
  const [file, setFile] = useState<File | null>(null)
  const [plan, setPlan] = useState<AnkiImportPlan | null>(null)
  const [projectName, setProjectName] = useState('')
  const [error, setError] = useState('')
  const [errorAction, setErrorAction] = useState<ErrorAction>('reselect')

  const abortCurrent = () => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  const closeModal = () => {
    if (state === 'importing') return
    abortCurrent()
    onClose()
  }

  useEffect(() => {
    const ownerDocument = rootRef.current?.ownerDocument
    if (!ownerDocument) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && state !== 'importing') closeModal()
    }
    ownerDocument.addEventListener('keydown', handleKeyDown)
    return () => ownerDocument.removeEventListener('keydown', handleKeyDown)
  })

  useEffect(
    () => () => {
      abortRef.current?.abort()
      abortRef.current = null
    },
    [],
  )

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
    setState('runtime')
    try {
      const packageBytes = await selected.arrayBuffer()
      if (controller.signal.aborted) return
      const nextPlan = await port.prepare({
        file: selected,
        packageBytes,
        baseDir,
        signal: controller.signal,
        onRuntimeReady: () => {
          if (!controller.signal.aborted) setState('parsing')
        },
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
      const renamed = renameAnkiImportPlan({
        plan,
        projectName: name,
        existingProjectSlugs: port.listExistingProjectSlugs(baseDir),
      })
      const projectPath = await port.commit({
        plan: renamed,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
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
    rootRef.current?.ownerDocument.defaultView?.setTimeout(
      () => chooseButtonRef.current?.focus(),
      0,
    )
  }

  const summary = plan ? summarizeAnkiImport(plan) : null
  const busy =
    state === 'runtime' || state === 'parsing' || state === 'importing'

  return (
    <LearningModal
      bodyClassName="yolo-anki-import-body"
      closeDisabled={state === 'importing'}
      closeLabel={t('learning.anki.close', 'Close')}
      dialogClassName="yolo-anki-import-dialog"
      onClose={closeModal}
      rootRef={rootRef}
      subtitle={t(
        'learning.anki.subtitle',
        'Preview an APKG before adding it to Learning Center.',
      )}
      title={t('learning.anki.title', 'Import from Anki')}
      footer={
        (state === 'preview' || state === 'error') && (
          <>
            <button
              className="yolo-learning-wizard-cancel"
              onClick={reselect}
              type="button"
            >
              {t('learning.anki.chooseAnother', 'Choose another file')}
            </button>
            {state === 'error' && errorAction === 'retry' && file ? (
              <button
                className="yolo-learning-wizard-primary"
                onClick={() =>
                  plan ? void importPlan() : void parseFile(file)
                }
                type="button"
              >
                {t('learning.anki.retry', 'Retry')}
              </button>
            ) : null}
            {state === 'preview' ? (
              <button
                className="yolo-learning-wizard-primary"
                onClick={() => void importPlan()}
                type="button"
              >
                {t('learning.anki.import', 'Import project')}
              </button>
            ) : null}
          </>
        )
      }
    >
      <div aria-live="polite">
        {state === 'selecting' ? (
          <LearningFileDropzone
            accept=".apkg"
            autoFocus
            buttonRef={chooseButtonRef}
            hint={t('learning.anki.fileLimit', 'Maximum file size: 200 MB')}
            onFiles={selectFiles}
            title={t('learning.anki.chooseFile', 'Choose one .apkg file')}
          />
        ) : null}

        {busy ? (
          <div className="yolo-anki-import-progress">
            <Loader2 aria-hidden size={22} />
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
            {file ? <span>{file.name}</span> : null}
          </div>
        ) : null}

        {state === 'error' ? (
          <div className="yolo-anki-import-error" role="alert">
            <AlertTriangle aria-hidden size={20} />
            <div>
              <strong>
                {t('learning.anki.errorTitle', 'Anki import stopped')}
              </strong>
              <p>{error}</p>
            </div>
          </div>
        ) : null}

        {state === 'preview' && plan && summary ? (
          <div className="yolo-anki-import-preview">
            <label className="yolo-anki-import-name">
              <span>{t('learning.anki.projectName', 'Project name')}</span>
              <input
                autoFocus
                onChange={(event) => setProjectName(event.currentTarget.value)}
                value={projectName}
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
            <PreviewList
              items={summary.chapterPaths}
              title={t('learning.anki.chapterPaths', 'Chapter paths')}
              withArchiveIcon
            />
            <PreviewList
              empty={t(
                'learning.anki.noWarnings',
                'No warnings or skipped items were reported.',
              )}
              items={plan.warnings}
              title={t('learning.anki.warnings', 'Warnings and skipped items')}
            />
          </div>
        ) : null}
      </div>
    </LearningModal>
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

function PreviewList({
  title,
  items,
  empty,
  withArchiveIcon = false,
}: {
  title: string
  items: readonly string[]
  empty?: string
  withArchiveIcon?: boolean
}) {
  return (
    <section className="yolo-anki-import-section">
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${index}-${item}`}>
              {withArchiveIcon ? <FileArchive aria-hidden size={14} /> : null}
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  )
}

function LearningModal({
  title,
  subtitle,
  onClose,
  closeLabel,
  closeDisabled,
  dialogClassName,
  bodyClassName,
  children,
  footer,
  rootRef,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  closeLabel: string
  closeDisabled: boolean
  dialogClassName?: string
  bodyClassName?: string
  children: ReactNode
  footer?: ReactNode
  rootRef: Ref<HTMLDivElement>
}) {
  const reactId = useId()
  const titleId = `yolo-learning-modal-${reactId.replace(/:/g, '')}`
  return (
    <div className="yolo-learning-modal-overlay" ref={rootRef}>
      <div
        aria-hidden
        className="yolo-learning-modal-backdrop"
        onClick={closeDisabled ? undefined : onClose}
      />
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className={cx('yolo-learning-modal-dialog', dialogClassName)}
        role="dialog"
      >
        <header className="yolo-learning-modal-header">
          <div>
            <div className="yolo-learning-modal-title" id={titleId}>
              {title}
            </div>
            {subtitle ? (
              <p className="yolo-learning-modal-subtitle">{subtitle}</p>
            ) : null}
          </div>
          <button
            aria-label={closeLabel}
            className="yolo-learning-modal-close"
            disabled={closeDisabled}
            onClick={onClose}
            type="button"
          >
            <X size={16} />
          </button>
        </header>
        <div
          className={cx(
            'yolo-learning-modal-body',
            'yolo-learning-scrollbar-thin',
            bodyClassName,
          )}
        >
          {children}
        </div>
        {footer ? (
          <footer className="yolo-learning-modal-footer">{footer}</footer>
        ) : null}
      </section>
    </div>
  )
}

const LearningFileDropzone = forwardRef<
  HTMLInputElement,
  {
    accept: string
    title: string
    hint: string
    onFiles: (files: File[]) => void
    buttonRef?: Ref<HTMLButtonElement>
    autoFocus?: boolean
  }
>(function LearningFileDropzone(
  { accept, title, hint, onFiles, buttonRef, autoFocus },
  inputRef,
) {
  const localInputRef = useRef<HTMLInputElement | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const setInputRef = (node: HTMLInputElement | null) => {
    localInputRef.current = node
    if (typeof inputRef === 'function') inputRef(node)
    else if (inputRef) inputRef.current = node
  }
  const handleFiles = (files: FileList | null) => {
    const selected = Array.from(files ?? [])
    if (selected.length) onFiles(selected)
  }
  return (
    <div className="yolo-learning-file-dropzone-wrap">
      <button
        autoFocus={autoFocus}
        className={cx(
          'yolo-learning-file-dropzone',
          isDragOver && 'is-drag-over',
        )}
        onClick={() => localInputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setIsDragOver(false)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragOver(false)
          handleFiles(event.dataTransfer.files)
        }}
        ref={buttonRef}
        type="button"
      >
        <span className="yolo-learning-file-dropzone-icon">
          <Upload size={18} />
        </span>
        <span className="yolo-learning-file-dropzone-copy">
          <strong>{title}</strong>
          <small>{hint}</small>
        </span>
      </button>
      <input
        accept={accept}
        className="yolo-learning-file-dropzone-input"
        onChange={(event) => {
          handleFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
        ref={setInputRef}
        type="file"
      />
    </div>
  )
})
