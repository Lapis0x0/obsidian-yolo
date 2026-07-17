import type {
  JsSandboxSettings,
  YoloSettings,
} from '../../settings/schema/setting.types'

import {
  JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB,
  JS_SANDBOX_DB_QUERY_DEFAULT_MAX_LIMIT,
  JS_SANDBOX_DB_QUERY_DEFAULT_REQUEST_LIMIT,
  JS_SANDBOX_DB_QUERY_HARD_MAX_LIMIT,
  JS_SANDBOX_FETCH_DEFAULT_MAX_CONCURRENT,
  JS_SANDBOX_FETCH_DEFAULT_MAX_RESPONSE_KB,
  JS_SANDBOX_FETCH_HARD_MAX_CONCURRENT,
  JS_SANDBOX_VAULT_LIST_MAX_ENTRIES,
  JS_SANDBOX_VAULT_READ_DEFAULT_MAX_KB,
  resolveJsSandboxOutputMaxBytes,
} from './jsSandboxTool'

export const JS_SANDBOX_BASE_DESCRIPTION =
  'Execute JavaScript in an isolated classic Worker and return JSON. Each call uses a fresh Worker; re-import/recreate state inside the same call. Single expressions are auto-returned; multi-statement code needs an explicit return. No DOM/document/Image; use Worker APIs (Blob, Response, Request, OffscreenCanvas, createImageBitmap, etc.).' +
  ' Errors: every await can reject — do NOT convert failed awaits to null via `.catch(() => null)` or empty catch blocks. Let exceptions propagate so the host returns `{ error, stack }`.' +
  ' Injected variables: $now (Date object), $isoDate ("YYYY-MM-DD" string), $note ({path:string,basename:string,frontmatter:Record}|null — null in Quick Ask or when no note is open), $content (string|null — full text of the active note), $selection (string|null — user\'s current text selection), $vault ({name:string, adapter:{basePath:string|null}}), $links (string[] — outgoing wiki-link targets from current note), $tags (string[] — tags from current note).' +
  ' $utils helpers — json: flatten(v), groupBy(items,key), countBy(items,key); text: markdownHeadings(md)->[{level,text,line}], tasks(md)->[{checked,status,text,indent,line}], wikilinks(md)->[{target,alias}]; stats: sum/mean/median/percentile(vals,p)/stdev(vals,sample?); matrix: identity(n)/multiply(a,b)/pow(m,exp); date: addDays(isoDate,days), diffDays(a,b), today().'

export type { JsSandboxSettings } from '../../settings/schema/setting.types'

/**
 * Single source of truth for the global JS sandbox configuration. Every
 * consumer (LLM-facing description, capability gate, proxy handler) reads
 * through this helper so the model's view of `js_eval` cannot drift from what
 * the host actually executes.
 *
 * Always returns a normalized view (see normalizeJsSandboxConfig) so any
 * legacy persisted state — e.g. `allowExternalScripts=true` saved before
 * fetch was implicit — is reconciled before downstream code reads it.
 */
export function getJsSandboxSettings(
  settings: Pick<YoloSettings, 'jsSandbox'> | null | undefined,
): JsSandboxSettings {
  return normalizeJsSandboxConfig(settings?.jsSandbox ?? {})
}

/**
 * Reconcile cross-capability invariants so every read path sees the same
 * shape: enabling external scripts implicitly enables network fetch, since
 * any remote script can call `fetch` itself the moment it is loaded.
 * Keeping the two flags coupled at the data layer avoids UI/runtime drift.
 */
export function normalizeJsSandboxConfig(
  config: JsSandboxSettings,
): JsSandboxSettings {
  if (!config.allowExternalScripts) {
    return config
  }
  if (config.allowFetch) {
    return config
  }
  return { ...config, allowFetch: true }
}

function resolveVaultReadDescriptionMaxKb(s: JsSandboxSettings): number {
  return typeof s.vaultReadMaxKb === 'number' && s.vaultReadMaxKb > 0
    ? s.vaultReadMaxKb
    : JS_SANDBOX_VAULT_READ_DEFAULT_MAX_KB
}

function describeVaultReadText(vaultCapKb: number): string {
  return `await $vault.readText(path) -> string|null (path is vault-relative, NOT absolute under $vault.adapter.basePath; null only if the file is missing; folder paths and read failures throw; text above ${vaultCapKb} KB is truncated)`
}

function describeHtmlParsingUtils(): string {
  return 'HTML parsing: await $utils.html.extract(html,{baseUrl?,maxTextChars?,maxItems?})->{title,lang,text,meta,headings:[{level,text}],links:[{text,href}],images:[{alt,src}]} (baseUrl resolves relative href/src); await $utils.html.select(html,cssSelector,{baseUrl?,limit?,includeHtml?})->[{tag,text,attrs,html?}]'
}

/**
 * Build the LLM-facing description. The base section only describes what's
 * always available; every conditional API (vault read, network, $db,
 * external scripts) — including its existence, signature, caps, and
 * error semantics — is added only when its capability is enabled. When
 * everything is off (the default), the model has no reason to try APIs
 * that don't exist, so the description stays minimal.
 */
export function buildJsSandboxToolDescription(s: JsSandboxSettings): string {
  const enabled: string[] = []
  const htmlParsingEnabled =
    s.allowFetch || s.allowExternalScripts || s.allowBrowserRead

  if (s.allowVaultRead) {
    const vaultCapKb = resolveVaultReadDescriptionMaxKb(s)
    enabled.push(
      `await $vault.list(path?, {recursive?: boolean}) -> Array<{kind:"dir"|"file",path,name,size?,mtime?}> (path defaults to "/", if provided path must be a string, direct children unless recursive true; hard safety cap ${JS_SANDBOX_VAULT_LIST_MAX_ENTRIES} entries; aggregate in JS, do NOT return the full list). ${describeVaultReadText(vaultCapKb)}; await $vault.readBinary(path) -> {base64,mimeType,byteLength}|null (same path/null/throw semantics; files above ${vaultCapKb} KB are refused; for Blob: \`new Blob([Uint8Array.from(atob(base64), c=>c.charCodeAt(0))], {type:mimeType})\`)`,
    )
  }

  if (s.allowFetch || s.allowExternalScripts) {
    const fetchCapKb =
      typeof s.fetchMaxResponseKb === 'number' && s.fetchMaxResponseKb > 0
        ? s.fetchMaxResponseKb
        : JS_SANDBOX_FETCH_DEFAULT_MAX_RESPONSE_KB
    const fetchMaxConcurrent =
      typeof s.fetchMaxConcurrent === 'number' &&
      Number.isFinite(s.fetchMaxConcurrent) &&
      s.fetchMaxConcurrent > 0
        ? Math.min(
            JS_SANDBOX_FETCH_HARD_MAX_CONCURRENT,
            Math.floor(s.fetchMaxConcurrent),
          )
        : JS_SANDBOX_FETCH_DEFAULT_MAX_CONCURRENT
    enabled.push(
      `Network: fetch/XMLHttpRequest/WebSocket are browser-native (CORS/CSP apply). For cross-origin reads: \`const data = await (await $fetch(url, {method?,headers?,body?,contentType?})).text()\`. Host-routed, ${fetchCapKb} KB cap, max ${fetchMaxConcurrent} concurrent calls per execution (excess throw)`,
    )
  }

  if (s.allowBrowserRead) {
    const browserCapKb =
      typeof s.browserReadMaxKb === 'number' && s.browserReadMaxKb > 0
        ? s.browserReadMaxKb
        : JS_SANDBOX_BROWSER_READ_DEFAULT_MAX_KB
    enabled.push(
      `Browser page HTML: await $browser.readHtml(pageId) -> {url,title,html,byteLength}|null (pageId must be copied exactly from <browser_context>; reads document.documentElement.outerHTML from an already-open Obsidian web page; does not open or fetch URLs; returns null if the page is no longer open; pages above ${browserCapKb} KB are refused; return aggregates or small excerpts unless the user explicitly needs raw HTML).`,
    )
  }

  if (htmlParsingEnabled) {
    enabled.push(describeHtmlParsingUtils())
  }

  if (s.allowDbQuery) {
    const dbLimit =
      typeof s.dbQueryMaxLimit === 'number' &&
      Number.isFinite(s.dbQueryMaxLimit) &&
      s.dbQueryMaxLimit > 0
        ? Math.min(
            JS_SANDBOX_DB_QUERY_HARD_MAX_LIMIT,
            Math.floor(s.dbQueryMaxLimit),
          )
        : JS_SANDBOX_DB_QUERY_DEFAULT_MAX_LIMIT
    const dbDefaultLimit = Math.min(
      JS_SANDBOX_DB_QUERY_DEFAULT_REQUEST_LIMIT,
      dbLimit,
    )
    const vaultCapKb = resolveVaultReadDescriptionMaxKb(s)
    const textReadHint = s.allowVaultRead
      ? 'For full content of a known result path, use the vault text reader described above.'
      : `${describeVaultReadText(vaultCapKb)} (available for full Markdown/text reads by known result path).`
    const binaryHint = s.allowVaultRead
      ? 'Do not use $db for images/PDF/audio/binary; use $vault.readBinary(path) for those.'
      : 'Do not use $db for images/PDF/audio/binary — those are out of scope.'
    enabled.push(
      `Text only, markdown-focused. await $db.search(query, limit?) -> [{path,content,similarity,...}] (knowledge-base RAG semantic/vector search; \`content\` is the matched chunk excerpt, not the full file; default ${dbDefaultLimit} results, requested limit is clamped to ${dbLimit}; throws when the vault has no index). ${textReadHint} ${binaryHint}`,
    )
  }

  if (s.allowExternalScripts) {
    // importScripts and nested Worker remain reachable at the JS API level
    // when this capability is on — this is not a lockdown, it is guidance.
    // We deliberately omit them from the model-facing description because
    // their failures (network / CSP / parse / eval) all surface as a
    // single opaque "Script error", which routinely misleads external
    // models into reporting a network problem when the real cause is a
    // CSP block or a syntax error in the fetched bundle. For remote
    // source loading we point the model at `$fetch(url).text()` instead,
    // which preserves status codes, response headers, and parse errors
    // separately — the model can then decide whether to `eval` / `new
    // Function` the source itself with useful diagnostics on failure.
    enabled.push(
      'External scripts: classic Worker globals — `document`/`location` absent (shim on globalThis; canvas → OffscreenCanvas). Network implicitly enabled. Load remote source via indirect eval (so UMD/IIFE bundles attach to globalThis): `(0, eval)(await (await $fetch(url)).text())`',
    )
  }

  const enabledLine =
    enabled.length > 0 ? ` Capabilities enabled: ${enabled.join('; ')}.` : ''

  // When both $vault and $db are on, the model needs picker logic — otherwise
  // it tends to default to $db (lossy excerpts) even for tasks that demand
  // exact bytes (path-keyed reads, line-aligned diffs, missing-file checks,
  // exhaustive scans over a known date/path set).
  const vaultVsDbLine =
    s.allowVaultRead && s.allowDbQuery
      ? ' $vault vs $db: use the vault APIs for exact path-based scans (raw text, missing-file checks, exhaustive scans); use $db.search to discover files by similarity.'
      : ''

  const outputCapBytes = resolveJsSandboxOutputMaxBytes(s.outputMaxKb)
  const outputCapKb = Math.floor(outputCapBytes / 1024)
  const returnLine = ` Output is JSON and truncated above ~${outputCapKb} KB; return aggregates + small samples, not raw collected data.`

  return `${JS_SANDBOX_BASE_DESCRIPTION}${enabledLine}${vaultVsDbLine}${returnLine}`
}
