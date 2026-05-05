export const formatTokenCount = (count: number): string => {
  if (count < 1000) {
    return String(count)
  }
  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return `${Math.round(count / 1000)}k`
}
