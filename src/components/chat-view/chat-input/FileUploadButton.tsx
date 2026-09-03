import { Plus } from 'lucide-react'
import type { ChangeEvent } from 'react'

import { useLanguage } from '../../../contexts/language-context'

const DOCUMENT_ACCEPT =
  'application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.log,text/plain,text/markdown,text/csv,text/tab-separated-values,application/json,application/xml,text/xml,application/yaml,text/yaml'

export function FileUploadButton({
  onUpload,
  allowImages = true,
}: {
  onUpload: (files: File[]) => void
  allowImages?: boolean
}) {
  const { t } = useLanguage()
  const label = t('chat.uploadFile', '添加文件')

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length > 0) {
      onUpload(files)
    }
    event.target.value = ''
  }

  return (
    <label
      className="yolo-chat-user-input-submit-button yolo-chat-user-input-upload-button"
      aria-label={label}
    >
      <input
        type="file"
        accept={allowImages ? `image/*,${DOCUMENT_ACCEPT}` : DOCUMENT_ACCEPT}
        multiple
        onChange={handleFileChange}
        hidden
      />
      <div className="yolo-chat-user-input-submit-button-icons">
        <Plus size={14} />
      </div>
    </label>
  )
}
