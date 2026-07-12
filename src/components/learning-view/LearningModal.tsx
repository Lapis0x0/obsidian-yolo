import cx from 'clsx'
import { Upload, X } from 'lucide-react'
import { type ReactNode, type Ref, forwardRef, useRef, useState } from 'react'

export function LearningModal({
  title,
  subtitle,
  onClose,
  closeLabel = 'Close',
  closeDisabled = false,
  dialogClassName,
  bodyClassName,
  children,
  footer,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  closeLabel?: string
  closeDisabled?: boolean
  dialogClassName?: string
  bodyClassName?: string
  children: ReactNode
  footer?: ReactNode
}) {
  const titleId = useRef(`yolo-learning-modal-${crypto.randomUUID()}`)

  return (
    <div className="yolo-learning-modal-overlay">
      <div
        className="yolo-learning-modal-backdrop"
        onClick={closeDisabled ? undefined : onClose}
        aria-hidden
      />
      <section
        className={cx('yolo-learning-modal-dialog', dialogClassName)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
      >
        <header className="yolo-learning-modal-header">
          <div>
            <div id={titleId.current} className="yolo-learning-modal-title">
              {title}
            </div>
            {subtitle && (
              <p className="yolo-learning-modal-subtitle">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={closeDisabled}
            className="yolo-learning-modal-close"
            aria-label={closeLabel}
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

        {footer && (
          <footer className="yolo-learning-modal-footer">{footer}</footer>
        )}
      </section>
    </div>
  )
}

export const LearningFileDropzone = forwardRef<
  HTMLInputElement,
  {
    accept: string
    multiple?: boolean
    title: string
    hint: string
    onFiles: (files: File[]) => void | Promise<void>
    buttonRef?: Ref<HTMLButtonElement>
    autoFocus?: boolean
    disabled?: boolean
  }
>(function LearningFileDropzone(
  {
    accept,
    multiple = false,
    title,
    hint,
    onFiles,
    buttonRef,
    autoFocus,
    disabled = false,
  },
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
    if (selected.length) void onFiles(selected)
  }

  return (
    <div className="yolo-learning-file-dropzone-wrap">
      <button
        ref={buttonRef}
        type="button"
        className={cx(
          'yolo-learning-file-dropzone',
          isDragOver && 'is-drag-over',
        )}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={() => localInputRef.current?.click()}
        onDragEnter={(event) => {
          event.preventDefault()
          setIsDragOver(true)
        }}
        onDragOver={(event) => {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setIsDragOver(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          setIsDragOver(false)
          handleFiles(event.dataTransfer.files)
        }}
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
        ref={setInputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        disabled={disabled}
        className="yolo-learning-file-dropzone-input"
        onChange={(event) => {
          handleFiles(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
    </div>
  )
})
