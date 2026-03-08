export type ApplyViewActions = {
  goToPreviousDiff: () => void
  goToNextDiff: () => void
  acceptIncomingActive: () => void
  acceptCurrentActive: () => void
  undoActive: () => void
  close: () => void
}
