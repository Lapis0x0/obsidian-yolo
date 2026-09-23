// The colour a one-click highlight is made in: the last colour picked for a
// highlight, remembered across boards and devices.
//
// Synchronized private storage rather than device-local like the reading
// panel's width (./readerPanelPrefs.ts): a highlighting colour is a habit of
// the person, not a fact about this screen, and a phone and a laptop reading
// the same papers should mark them the same way.

import {
  type AnnotationColor,
  DEFAULT_ANNOTATION_COLOR,
  isAnnotationColor,
} from '../domain/pdfAnnotations'

type PrivateScope = YoloModuleHostApiV1['privateStorage']['synchronized']

const KEY = 'pdf-annotations.json'

export class AnnotationPrefs {
  private color: AnnotationColor | null = null
  private loading = false

  constructor(
    private readonly storage: PrivateScope,
    private readonly reportError: (stage: string, error: unknown) => void,
  ) {}

  /** Reads the stored colour, once; until it lands, the default applies. */
  load(): void {
    if (this.loading) return
    this.loading = true
    void this.storage
      .readJson<{ defaultColor?: unknown }>(KEY)
      .then((stored) => {
        const color = stored?.defaultColor
        if (
          this.color === null &&
          typeof color === 'string' &&
          isAnnotationColor(color)
        ) {
          this.color = color
        }
      })
      .catch((error: unknown) => {
        this.loading = false
        this.reportError('annotation prefs', error)
      })
  }

  getDefaultColor(): AnnotationColor {
    return this.color ?? DEFAULT_ANNOTATION_COLOR
  }

  setDefaultColor(color: AnnotationColor): void {
    if (color === this.getDefaultColor() && this.color !== null) return
    this.color = color
    void this.storage
      .writeJson(KEY, { defaultColor: color })
      .catch((error: unknown) => this.reportError('annotation prefs', error))
  }
}
