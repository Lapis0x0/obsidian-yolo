export const MAX_AUTOMATIC_RETRIES = 3

export type AutomaticRetrySchedule = readonly [number, number, number]

export type NextAutomaticRetry = Readonly<{
  retryCount: number
  delayMs: number
}>

export function getNextAutomaticRetry(
  retryCount: number,
  schedule: AutomaticRetrySchedule,
): NextAutomaticRetry | null {
  if (
    !Number.isSafeInteger(retryCount) ||
    retryCount < 0 ||
    retryCount >= MAX_AUTOMATIC_RETRIES
  ) {
    return null
  }

  return Object.freeze({
    retryCount: retryCount + 1,
    delayMs: schedule[retryCount],
  })
}
