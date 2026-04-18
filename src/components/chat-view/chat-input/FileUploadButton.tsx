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
      className="smtcmp-chat-user-input-submit-button smtcmp-chat-user-input-upload-button"
      title={label}
      aria-label={label}
    >
      <input
        type="file"
        accept="image/*,application/pdf"
        multiple
        onChange={handleFileChange}
        hidden
      />
      <div className="smtcmp-chat-user-input-submit-button-icons">
        <Plus size={14} />
      </div>
    </label>
  )
}
