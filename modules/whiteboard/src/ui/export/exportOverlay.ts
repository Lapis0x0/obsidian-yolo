// The cover a board export puts over the board while it walks the camera
// across it (./boardExport.ts): how far along it is, and a way to stop it.
// Styles in styles/canvas/export.css.
//
// Popout safety: built from the document of the element it covers.

const OVERLAY_CLASS = 'yolo-whiteboard-export-overlay'
const PANEL_CLASS = 'yolo-whiteboard-export-panel'
const TITLE_CLASS = 'yolo-whiteboard-export-title'
const DETAIL_CLASS = 'yolo-whiteboard-export-detail'
const TRACK_CLASS = 'yolo-whiteboard-export-track'
const BAR_CLASS = 'yolo-whiteboard-export-bar'
const CANCEL_CLASS = 'yolo-whiteboard-export-cancel'

export class ExportOverlay {
  private readonly el: HTMLElement
  private readonly detailEl: HTMLElement
  private readonly barEl: HTMLElement

  constructor(
    parent: HTMLElement,
    text: Readonly<{ title: string; cancel: string }>,
    onCancel: () => void,
  ) {
    const doc = parent.ownerDocument
    this.el = doc.createElement('div')
    this.el.className = OVERLAY_CLASS
    // Everything that lands on the cover stays there: the board under it is
    // being photographed and must not be panned, zoomed or clicked.
    for (const type of ['pointerdown', 'wheel', 'contextmenu', 'dblclick']) {
      this.el.addEventListener(type, (e) => {
        e.stopPropagation()
        if (type !== 'pointerdown') e.preventDefault()
      })
    }
    const panel = doc.createElement('div')
    panel.className = PANEL_CLASS
    const title = doc.createElement('div')
    title.className = TITLE_CLASS
    title.textContent = text.title
    this.detailEl = doc.createElement('div')
    this.detailEl.className = DETAIL_CLASS
    const track = doc.createElement('div')
    track.className = TRACK_CLASS
    this.barEl = doc.createElement('div')
    this.barEl.className = BAR_CLASS
    track.appendChild(this.barEl)
    const cancel = doc.createElement('button')
    cancel.className = CANCEL_CLASS
    cancel.textContent = text.cancel
    cancel.addEventListener('click', onCancel)
    panel.append(title, this.detailEl, track, cancel)
    this.el.appendChild(panel)
    parent.appendChild(this.el)
  }

  /** `done` of `total` parts of the picture made. */
  setProgress(done: number, total: number, detail: string): void {
    const fraction = total > 0 ? Math.min(1, done / total) : 0
    this.barEl.style.transform = `scaleX(${fraction})`
    this.detailEl.textContent = detail
  }

  destroy(): void {
    this.el.remove()
  }
}
