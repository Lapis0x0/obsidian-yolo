export type DecodedCodexExecToolCall = {
  name: string
  input: Record<string, unknown>
}

type JavaScriptToken = {
  kind: 'identifier' | 'number' | 'string' | 'punctuation'
  value: string
}

type ExecEnvelopeToolCall = {
  name: string
  toolTokenIndex: number
  openParenTokenIndex: number
}

export const decodeCodexExecEnvelope = (
  source: string,
): DecodedCodexExecToolCall[] | null => {
  if (!source.trim()) return null
  const tokens = tokenize(source)
  if (!tokens) return null
  const calls = findToolCalls(tokens)
  if (!calls || calls.length === 0) return null

  const decoded: DecodedCodexExecToolCall[] = []
  for (const call of calls) {
    const input = decodeToolInput(tokens, call)
    if (!input) return null
    decoded.push({
      name: call.name,
      input: normalizeCodexToolInput(call.name, input),
    })
  }
  return decoded
}

export const splitCodexExecEnvelopeOutput = (
  output: unknown,
  toolCallCount: number,
): unknown[] | null => {
  if (!Array.isArray(output)) return null
  const parts: unknown[] = []
  for (const part of output) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return null
    const text = (part as Record<string, unknown>).text
    parts.push(typeof text === 'string' ? text : [part])
  }
  if (
    parts.length === toolCallCount + 1 &&
    typeof parts[0] === 'string' &&
    parts[0].startsWith('Script ') &&
    parts[0].endsWith('Output:\n')
  ) {
    return parts.slice(1)
  }
  return parts.length === toolCallCount ? parts : null
}

export const normalizeCodexToolInput = (
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> => {
  if (name === 'exec_command') {
    return {
      command:
        typeof input.command === 'string'
          ? input.command
          : typeof input.cmd === 'string'
            ? input.cmd
            : '',
      ...(typeof input.workdir === 'string' ? { cwd: input.workdir } : {}),
    }
  }
  if (name === 'view_image') {
    return {
      ...input,
      file_path:
        typeof input.file_path === 'string'
          ? input.file_path
          : typeof input.path === 'string'
            ? input.path
            : '',
    }
  }
  return input
}

const tokenize = (source: string): JavaScriptToken[] | null => {
  const tokens: JavaScriptToken[] = []
  for (let index = 0; index < source.length; ) {
    const char = source[index] ?? ''
    const next = source[index + 1] ?? ''
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index + 2)
      index = lineEnd < 0 ? source.length : lineEnd + 1
      continue
    }
    if (char === '/' && next === '*') {
      const commentEnd = source.indexOf('*/', index + 2)
      if (commentEnd < 0) return null
      index = commentEnd + 2
      continue
    }
    if (char === '"' || char === "'") {
      const token = readStringToken(source, index)
      if (!token) return null
      tokens.push({ kind: 'string', value: token.value })
      index = token.end
      continue
    }
    // Templates and regular expressions need a full JavaScript parser. Keep
    // the outer exec card instead of guessing.
    if (char === '`' || char === '/') return null
    if (/[A-Za-z_$]/.test(char)) {
      let end = index + 1
      while (end < source.length && /[\w$]/.test(source[end] ?? '')) end += 1
      tokens.push({ kind: 'identifier', value: source.slice(index, end) })
      index = end
      continue
    }
    if (/\d/.test(char)) {
      const match = source.slice(index).match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)
      if (!match) return null
      tokens.push({ kind: 'number', value: match[0] })
      index += match[0].length
      continue
    }
    tokens.push({ kind: 'punctuation', value: char })
    index += 1
  }
  return tokens
}

const readStringToken = (
  source: string,
  start: number,
): { value: string; end: number } | null => {
  const quote = source[start]
  if (quote !== '"' && quote !== "'") return null
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1
      continue
    }
    if (source[index] !== quote) continue
    const literal = source.slice(start, index + 1)
    if (quote === '"') {
      try {
        const parsed = JSON.parse(literal) as unknown
        return typeof parsed === 'string'
          ? { value: parsed, end: index + 1 }
          : null
      } catch {
        return null
      }
    }
    return {
      value: decodeSingleQuotedString(literal.slice(1, -1)),
      end: index + 1,
    }
  }
  return null
}

const findToolCalls = (
  tokens: readonly JavaScriptToken[],
): ExecEnvelopeToolCall[] | null => {
  const calls: ExecEnvelopeToolCall[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (
      token?.kind !== 'identifier' ||
      token.value !== 'tools' ||
      tokens[index - 1]?.value === '.'
    ) {
      continue
    }
    if (
      tokens[index + 1]?.value !== '.' ||
      tokens[index + 2]?.kind !== 'identifier' ||
      tokens[index + 3]?.value !== '('
    ) {
      return null
    }
    calls.push({
      name: tokens[index + 2].value,
      toolTokenIndex: index,
      openParenTokenIndex: index + 3,
    })
  }
  return calls
}

const decodeToolInput = (
  tokens: readonly JavaScriptToken[],
  call: ExecEnvelopeToolCall,
): Record<string, unknown> | null => {
  if (call.name === 'apply_patch') {
    const patch = extractApplyPatch(tokens, call)
    return patch ? { patch } : null
  }
  const close = findMatchingToken(tokens, call.openParenTokenIndex, '(', ')')
  if (close === null) return null
  if (call.openParenTokenIndex + 1 === close) return {}
  const parsed = parseStaticValue(tokens, call.openParenTokenIndex + 1)
  if (!parsed || parsed.next !== close) return null
  return parsed.value &&
    typeof parsed.value === 'object' &&
    !Array.isArray(parsed.value)
    ? (parsed.value as Record<string, unknown>)
    : { value: parsed.value }
}

type ParsedValue = { value: unknown; next: number }

const parseStaticValue = (
  tokens: readonly JavaScriptToken[],
  index: number,
): ParsedValue | null => {
  const token = tokens[index]
  if (!token) return null
  if (token.kind === 'string') return { value: token.value, next: index + 1 }
  if (token.kind === 'number') {
    const value = Number(token.value)
    return Number.isFinite(value) ? { value, next: index + 1 } : null
  }
  if (token.kind === 'identifier') {
    if (token.value === 'true') return { value: true, next: index + 1 }
    if (token.value === 'false') return { value: false, next: index + 1 }
    if (token.value === 'null') return { value: null, next: index + 1 }
    return null
  }
  if (token.value === '-') {
    const next = tokens[index + 1]
    if (next?.kind !== 'number') return null
    const value = -Number(next.value)
    return Number.isFinite(value) ? { value, next: index + 2 } : null
  }
  if (token.value === '{') return parseObject(tokens, index)
  if (token.value === '[') return parseArray(tokens, index)
  return null
}

const parseObject = (
  tokens: readonly JavaScriptToken[],
  open: number,
): ParsedValue | null => {
  const value: Record<string, unknown> = {}
  let index = open + 1
  while (index < tokens.length) {
    const token = tokens[index]
    if (token?.value === '}') return { value, next: index + 1 }
    if (token?.kind !== 'identifier' && token?.kind !== 'string') return null
    if (tokens[index + 1]?.value !== ':') return null
    const parsed = parseStaticValue(tokens, index + 2)
    if (!parsed) return null
    value[token.value] = parsed.value
    index = parsed.next
    if (tokens[index]?.value === ',') {
      index += 1
      continue
    }
    if (tokens[index]?.value !== '}') return null
  }
  return null
}

const parseArray = (
  tokens: readonly JavaScriptToken[],
  open: number,
): ParsedValue | null => {
  const value: unknown[] = []
  let index = open + 1
  while (index < tokens.length) {
    if (tokens[index]?.value === ']') return { value, next: index + 1 }
    const parsed = parseStaticValue(tokens, index)
    if (!parsed) return null
    value.push(parsed.value)
    index = parsed.next
    if (tokens[index]?.value === ',') {
      index += 1
      continue
    }
    if (tokens[index]?.value !== ']') return null
  }
  return null
}

const extractApplyPatch = (
  tokens: readonly JavaScriptToken[],
  call: ExecEnvelopeToolCall,
): string | null => {
  const argument = tokens[call.openParenTokenIndex + 1]
  if (argument?.kind === 'string') return argument.value
  if (argument?.kind !== 'identifier') return null
  let patch: string | null = null
  for (let index = 0; index <= call.toolTokenIndex - 4; index += 1) {
    if (
      tokens[index]?.kind === 'identifier' &&
      ['const', 'let', 'var'].includes(tokens[index].value) &&
      tokens[index + 1]?.value === argument.value &&
      tokens[index + 2]?.value === '=' &&
      tokens[index + 3]?.kind === 'string'
    ) {
      patch = tokens[index + 3]?.value ?? null
    }
  }
  return patch
}

const findMatchingToken = (
  tokens: readonly JavaScriptToken[],
  openIndex: number,
  open: string,
  close: string,
): number | null => {
  let depth = 0
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.value === open) depth += 1
    else if (tokens[index]?.value === close && --depth === 0) return index
  }
  return null
}

const decodeSingleQuotedString = (value: string): string =>
  value.replace(/\\([\\'"nrtbfv0])/g, (_match, escaped: string) => {
    const escapes: Record<string, string> = {
      '\\': '\\',
      "'": "'",
      '"': '"',
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      0: '\0',
    }
    return escapes[escaped] ?? escaped
  })
