export const shouldProceedToToolPhase = (turnResult: {
  toolCallRequests: Array<unknown>
}): boolean => {
  return turnResult.toolCallRequests.length > 0
}
