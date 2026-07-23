/**
 * 配置导入/导出过程中的敏感字段处理。
 *
 * 敏感字段覆盖范围（来自当前 settings schema 实际可能存放凭证的位置）：
 * - `apiKey: string`：providers、各 webSearch provider 都用这个字段名
 * - `password: string`：webSearch.searxng
 * - `headers: { [k]: string }` 内所有 value：mcp http/sse transport
 * - `env: { [k]: string }` 内所有 value：mcp stdio transport
 * - `customHeaders: [{ key, value }]` 中每项的 value：providers 的自定义请求头
 * - `mcp.localServer.token`：本地 MCP 服务的认证 token
 *
 * 走单一 walker，导出用 replace（随机字符串），导入用 strip（清空字符串）。
 * 不在白名单内的字段名一律不动，避免误杀业务数据。
 */

type WalkOp = (value: string) => string

const SENSITIVE_STRING_FIELDS = new Set(['apiKey', 'password'])
const SENSITIVE_RECORD_FIELDS = new Set(['headers', 'env'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  )
}

function transformRecord(
  record: Record<string, unknown>,
  op: WalkOp,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string') {
      out[k] = op(v)
    } else {
      out[k] = v
    }
  }
  return out
}

function transformCustomHeaders(items: unknown[], op: WalkOp): unknown[] {
  return items.map((item) => {
    if (!isPlainObject(item)) return item
    const value = item['value']
    if (typeof value !== 'string') return item
    return { ...item, value: op(value) }
  })
}

/**
 * 递归扫描配置树，对所有已知敏感字段应用 op。
 * 返回新对象，不修改输入。
 */
export function mapSensitiveValues(data: unknown, op: WalkOp): unknown {
  return mapSensitiveValuesAtPath(data, op, [])
}

function mapSensitiveValuesAtPath(
  data: unknown,
  op: WalkOp,
  path: readonly string[],
): unknown {
  if (Array.isArray(data)) {
    return data.map((item) => mapSensitiveValuesAtPath(item, op, path))
  }
  if (!isPlainObject(data)) return data

  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveStringField(key, path) && typeof value === 'string') {
      result[key] = op(value)
      continue
    }
    if (SENSITIVE_RECORD_FIELDS.has(key) && isPlainObject(value)) {
      result[key] = transformRecord(value, op)
      continue
    }
    if (key === 'customHeaders' && Array.isArray(value)) {
      result[key] = transformCustomHeaders(value, op)
      continue
    }
    result[key] = mapSensitiveValuesAtPath(value, op, [...path, key])
  }
  return result
}

function isSensitiveStringField(
  key: string,
  parentPath: readonly string[],
): boolean {
  if (SENSITIVE_STRING_FIELDS.has(key)) return true
  // `token` is intentionally path-sensitive: a generic name-based rule would
  // redact unrelated module or business fields. In the Host settings schema,
  // this exact path is the local MCP authentication secret.
  return key === 'token' && parentPath.join('.') === 'mcp.localServer'
}

/**
 * 用等长随机字符串替换所有敏感值。空字符串保持空。
 * 仅用于视觉脱敏，不需要密码学强度。
 */
export function redactSensitive(data: unknown): unknown {
  return mapSensitiveValues(data, (value) =>
    value.length > 0 ? randomString(value.length) : '',
  )
}

/**
 * 把所有敏感值清空（设为空字符串）。
 * 用于导入端：脱敏导出文件里的随机字符串绝不能当真 key 写入。
 */
export function clearSensitive(data: unknown): unknown {
  return mapSensitiveValues(data, () => '')
}

/**
 * 探测对象树中是否实际存在任意"非空字符串"的敏感值。
 * 用于 UI 动态判定某个顶层 key 的实例是否真的含凭证，
 * 替代过去基于类目的静态 `sensitive: true` 标记，
 * 避免给"没配 apiKey 的 Ollama / 无 env 的 MCP"误打标。
 */
export function hasNonEmptyCredentials(data: unknown): boolean {
  return hasNonEmptyCredentialsAtPath(data, [])
}

function hasNonEmptyCredentialsAtPath(
  data: unknown,
  path: readonly string[],
): boolean {
  if (Array.isArray(data)) {
    return data.some((item) => hasNonEmptyCredentialsAtPath(item, path))
  }
  if (!isPlainObject(data)) return false

  for (const [key, value] of Object.entries(data)) {
    if (isSensitiveStringField(key, path)) {
      if (typeof value === 'string' && value.length > 0) return true
      continue
    }
    if (SENSITIVE_RECORD_FIELDS.has(key) && isPlainObject(value)) {
      for (const inner of Object.values(value)) {
        if (typeof inner === 'string' && inner.length > 0) return true
      }
      continue
    }
    if (key === 'customHeaders' && Array.isArray(value)) {
      for (const item of value) {
        if (!isPlainObject(item)) continue
        const v = item['value']
        if (typeof v === 'string' && v.length > 0) return true
      }
      continue
    }
    if (hasNonEmptyCredentialsAtPath(value, [...path, key])) return true
  }
  return false
}

function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}
