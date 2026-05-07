import { App } from '../../runtime/react-compat'

import { ReactModal } from '../common/ReactModal'

type InstallerUpdateRequiredModalProps = Record<string, never>

export class InstallerUpdateRequiredModal extends ReactModal<InstallerUpdateRequiredModalProps> {
  constructor(app: App) {
    super({
      app: app,
      Component: InstallerUpdateRequiredModalComponent,
      props: {},
      options: {
        title: 'YOLO Requires Obsidian Update',
      },
    })
  }
}

function InstallerUpdateRequiredModalComponent({
  onClose: _onClose,
}: InstallerUpdateRequiredModalProps & { onClose: () => void }) {
  return (
    <div>
      <div>
        YOLO requires a newer version of the Obsidian installer. Please note
        that this is different from Obsidian&apos;s in-app updates. You must
        manually download the latest version of Obsidian to continue using YOLO.
      </div>
      <div>
        <div className="modal-button-container">
          <button
            className="mod-cta"
            onClick={() => {
              window.open('https://obsidian.md/download')
            }}
          >
            Open Download Page
          </button>
        </div>
      </div>
    </div>
  )
}
