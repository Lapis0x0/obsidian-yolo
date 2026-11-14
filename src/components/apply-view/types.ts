export type ApplyViewActions = {
  goToPreviousDiff: () => void
  goToNextDiff: () => void
  acceptIncomingActive: () => void
  acceptCurrentActive: () => void
  close: () => void
  /** Scroll the current change into view and focus the editor. */
  revealActive: () => void
}
