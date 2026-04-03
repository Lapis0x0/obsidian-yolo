import { ImageIcon } from 'lucide-react'
import type { ChangeEvent } from 'react'

import { useLanguage } from '../../../contexts/language-context'

export function ImageUploadButton({
  onUpload,
}: {
  onUpload: (files: File[]) => void
}) {
  const { t } = useLanguage()

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    if (files.length > 0) {
      onUpload(files)
    }
    event.target.value = ''
  }

  return (
    <label className="smtcmp-chat-user-input-submit-button">
      <input
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileChange}
        hidden
      />
      <div className="smtcmp-chat-user-input-submit-button-icons">
        <ImageIcon size={12} />
      </div>
      <div className="smtcmp-chat-user-input-submit-button-label">
        {t('chat.uploadImage', '上传图片')}
      </div>
    </label>
  )
}
