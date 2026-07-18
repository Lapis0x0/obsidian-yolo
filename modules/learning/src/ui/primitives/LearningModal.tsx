import cx from 'clsx'
import { Upload, X } from 'lucide-react'
import {
  type ReactNode,
  type Ref,
  forwardRef,
  useId,
  useRef,
  useState,
} from 'react'

export function LearningModal({
  title,
  onClose,
  closeLabel = 'Close',
  children,
  footer,
}: {
  title: string
  onClose: () => void
  closeLabel?: string
  children: ReactNode
  footer?: ReactNode
}) {
  const titleId = useId()

  return (
    <div className="yolo-learning-modal-overlay">
      <div
        className="yolo-learning-modal-backdrop"
        onClick={onClose}
        aria-hidden
      />
      <section
        className="yolo-learning-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="yolo-learning-modal-header">
          <div id={titleId} className="yolo-learning-modal-title">
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="yolo-learning-modal-close"
            aria-label={closeLabel}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="yolo-learning-modal-body yolo-learning-scrollbar-thin">
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
    if (selected.length > 0) void onFiles(selected)
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
          <Upload size={18} aria-hidden />
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
