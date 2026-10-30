import { type App, Modal } from 'obsidian'

import type { MentionableImage } from '../../types/mentionable'

/** An attached image at full size. Escape or a click outside closes it. */
export class ImagePreviewModal extends Modal {
  constructor(
    app: App,
    private readonly image: MentionableImage,
  ) {
    super(app)
  }

  onOpen(): void {
    this.modalEl.addClass('yolo-image-preview-modal')
    this.titleEl.setText(this.image.name)
    this.contentEl.createEl('img', {
      cls: 'yolo-image-preview-modal-image',
      attr: { src: this.image.data, alt: this.image.name },
    })
  }

  onClose(): void {
    this.contentEl.empty()
  }
}
