type Template = { name?: string; ord: number; qfmt: string; afmt: string }
export type AnkiModel = {
  id: number
  name: string
  fields: string[]
  templates: Template[]
  cloze: boolean
}

const renderConditionals = (
  template: string,
  values: Record<string, string>,
): string =>
  template.replace(
    /{{([#^])([^{}]+)}}([\s\S]*?){{\/\2}}/g,
    (_m, mode, field, body) =>
      mode === '#'
        ? values[field]?.trim()
          ? body
          : ''
        : values[field]?.trim()
          ? ''
          : body,
  )

const renderFields = (
  template: string,
  values: Record<string, string>,
): string =>
  renderConditionals(template, values)
    .replace(
      /{{(?:[^}:]+:)*([^{}]+)}}/g,
      (_match, field: string) => values[field.trim()] ?? '',
    )
    .replace(/<style[\s\S]*?<\/style>/gi, '')

const clozeText = (value: string, ordinal: number, answer: boolean): string =>
  value.replace(
    /{{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?}}/gi,
    (_m, raw, content, hint) => {
      if (Number(raw) !== ordinal + 1) return content
      return answer ? content : `[${hint || '...'}]`
    },
  )

export const renderCardTemplate = (
  model: AnkiModel,
  fields: string[],
  ordinal: number,
): { front: string; back: string } | null => {
  const template = model.templates.find((item) => item.ord === ordinal)
  if (!template) return null
  const values = Object.fromEntries(
    model.fields.map((name, index) => [name, fields[index] ?? '']),
  )
  if (model.cloze) {
    const questionValues = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        clozeText(value, ordinal, false),
      ]),
    )
    const answerValues = Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        clozeText(value, ordinal, true),
      ]),
    )
    return {
      front: renderFields(template.qfmt, questionValues),
      back: renderFields(template.afmt, {
        ...answerValues,
        FrontSide: renderFields(template.qfmt, questionValues),
      }),
    }
  }
  const front = renderFields(template.qfmt, values)
  return {
    front,
    back: renderFields(template.afmt, { ...values, FrontSide: front }),
  }
}
