import { RotateCcw } from 'lucide-react'
import { App } from 'obsidian'
import { useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { DEFAULT_BLOCKED_PREFIXES } from '../../../core/agent/bash/command-classifier'
import { ReactModal } from '../../common/ReactModal'
import { StringListInput } from '../inputs/StringListInput'

type TerminalCommandConfigModalProps = {
  app: App
  value: string[]
  onChange: (next: string[]) => void
}

export class TerminalCommandConfigModal extends ReactModal<TerminalCommandConfigModalProps> {
  constructor(
    app: App,
    options: {
      title: string
      value: string[]
      onChange: (next: string[]) => void
    },
  ) {
    super({
      app,
      Component: TerminalCommandConfigModalContent,
      props: {
        app,
        value: options.value,
        onChange: options.onChange,
      },
      options: {
        title: options.title,
        className: 'yolo-terminal-command-modal',
      },
    })
  }
}

function TerminalCommandConfigModalContent({
  value,
  onChange,
}: TerminalCommandConfigModalProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [prefixes, setPrefixes] = useState(() => value)

  const update = (next: string[]) => {
    const normalized = next
      .map((item) => item.trim())
      .filter(
        (item, index, list) => item.length > 0 && list.indexOf(item) === index,
      )
    setPrefixes(normalized)
    onChange(normalized)
  }

  return (
    <div className="yolo-terminal-command-config">
      <section className="yolo-terminal-command-section">
        <div className="yolo-terminal-command-section-head">
          <div>
            <h3>
              {t(
                'settings.terminalCommand.blockedPrefixes',
                'Blocked command prefixes',
              )}
            </h3>
            <p>
              {t(
                'settings.terminalCommand.blockedPrefixesDesc',
                'Commands matching these prefixes will be rejected before execution.',
              )}
            </p>
          </div>
        </div>

        <div className="yolo-terminal-command-rule">
          {t(
            'settings.terminalCommand.matchingRule',
            'Prefix matching uses the first command token: rm blocks rm -rf /, but not npm run build.',
          )}
        </div>

        <StringListInput
          value={prefixes}
          onChange={update}
          placeholder={t(
            'settings.terminalCommand.addPrefixPlaceholder',
            'Command prefix, e.g. rm',
          )}
          addLabel={t('common.add', 'Add')}
          removeLabel={t('common.remove', 'Remove')}
        />

        <button
          type="button"
          className="mod-cta yolo-terminal-command-reset"
          onClick={() => update([...DEFAULT_BLOCKED_PREFIXES])}
        >
          <RotateCcw size={15} />
          {t('settings.terminalCommand.resetDefaults', 'Reset to defaults')}
        </button>
      </section>
    </div>
  )
}
