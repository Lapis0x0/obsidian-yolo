import { Plus } from 'lucide-react'
import type { ChangeEvent } from 'react'

import { useLanguage } from '../../../contexts/language-context'

export function FileUploadButton({
  onUpload,
}: {
  onUpload: (files: File[]) => void
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
        accept="image/*,application/pdf"
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
