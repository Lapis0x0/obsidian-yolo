export function formatLearningText(
  template: string,
  values: Record<string, string | number>,
) {
  return Object.entries(values).reduce(
    (text, [key, value]) =>
      text
        .split(`{{${key}}}`)
        .join(String(value))
        .split(`{${key}}`)
        .join(String(value)),
    template,
  )
}
