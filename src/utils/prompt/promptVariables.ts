const PROMPT_VARIABLE_PATTERN = /{{\s*([a-z_]+)(?::([a-z_]+))?\s*}}/gi

const pad2 = (value: number): string => value.toString().padStart(2, '0')

const formatLocalDate = (date: Date): string => {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

const formatLocalHour = (date: Date): string => {
  return `${formatLocalDate(date)} ${pad2(date.getHours())}`
}

const formatLocalMinute = (date: Date): string => {
  return `${formatLocalHour(date)}:${pad2(date.getMinutes())}`
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const formatLocalWeekday = (date: Date): string => {
  return WEEKDAY_NAMES[date.getDay()] ?? WEEKDAY_NAMES[0]
}

const resolvePromptVariable = (
  variableName: string,
  variableGranularity: string | undefined,
  now: Date,
): string | null => {
  const normalizedName = variableName.toLowerCase()
  const normalizedGranularity = variableGranularity?.toLowerCase()

  if (normalizedName === 'current_date') {
    return formatLocalDate(now)
  }

  if (normalizedName === 'current_hour') {
    return formatLocalHour(now)
  }

  if (normalizedName === 'current_minute') {
    return formatLocalMinute(now)
  }

  if (normalizedName === 'current_weekday') {
    return formatLocalWeekday(now)
  }

  if (normalizedName !== 'current_time' || !normalizedGranularity) {
    return null
  }

  switch (normalizedGranularity) {
    case 'date':
      return formatLocalDate(now)
    case 'hour':
      return formatLocalHour(now)
    case 'minute':
      return formatLocalMinute(now)
    case 'weekday':
      return formatLocalWeekday(now)
    default:
      return null
  }
}

export const resolvePromptVariables = (
  text: string,
  options?: {
    now?: Date
  },
): string => {
  if (!text.includes('{{')) {
    return text
  }

  const now = options?.now ?? new Date()
  return text.replace(
    PROMPT_VARIABLE_PATTERN,
    (match, variableName: string, variableGranularity?: string) => {
      const resolved = resolvePromptVariable(
        variableName,
        variableGranularity,
        now,
      )
      return resolved ?? match
    },
  )
}
