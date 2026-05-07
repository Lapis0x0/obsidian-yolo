import { App, Editor } from '../../runtime/react-compat'
import React, { useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { usePlugin } from '../../contexts/plugin-context'
import SmartComposerPlugin from '../../main'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ObsidianTextArea } from '../common/ObsidianTextArea'
import { ReactModal } from '../common/ReactModal'

export type SmartSpaceModalProps = {
  editor: Editor
}

function SmartSpaceComponent({
  editor,
  onClose,
}: SmartSpaceModalProps & { onClose: () => void }) {
  const plugin = usePlugin()
  const { t } = useLanguage()
  const [instruction, setInstruction] = useState('')

  const handleConfirm = () => {
    onClose()
    void plugin
      .continueWriting(
        editor,
        instruction.trim().length > 0 ? instruction : undefined,
      )
      .catch((error) => {
        console.error('Failed to continue writing from SmartSpace modal', error)
      })
  }

  return (
    <>
      <div className="smtcmp-modal-input-container">
        <ObsidianTextArea
          value={instruction}
          placeholder={t('chat.customContinuePromptPlaceholder') ?? ''}
          onChange={(v) => setInstruction(v)}
          inputClassName="smtcmp-instruction-textarea"
        />
      </div>

      <ObsidianSetting>
        <ObsidianButton
          text={t('common.confirm')}
          onClick={handleConfirm}
          cta
        />
        <ObsidianButton text={t('common.cancel')} onClick={onClose} />
      </ObsidianSetting>
    </>
  )
}

export class SmartSpaceModal extends ReactModal<SmartSpaceModalProps> {
  constructor({
    app,
    plugin,
    editor,
  }: {
    app: App
    plugin: SmartComposerPlugin
    editor: Editor
  }) {
    super({
      app,
      Component: SmartSpaceComponent,
      props: { editor },
      options: { title: plugin.t('commands.customContinueWriting') },
      plugin,
    })
  }
}
