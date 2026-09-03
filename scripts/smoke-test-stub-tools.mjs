#!/usr/bin/env node
// Smoke test: verify that the on-demand tool stub format from
// src/core/agent/tool-stub.ts is accepted by each provider's real API,
// and that the model uses tool_search (rather than the stub) when asked
// to operate before the schema is disclosed.
//
// Reads credentials from ./data.json.
// Usage:
//   node scripts/smoke-test-stub-tools.mjs [anthropic|openai-chat|openai-responses|gemini|all]

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = process.cwd()
const data = JSON.parse(readFileSync(resolve(ROOT, 'data.json'), 'utf8'))
const target = process.argv[2] ?? 'all'

const findProvider = (id) => data.providers.find((p) => p.id === id)
const norm = (s) => (s ?? '').replace(/\/$/, '')
const deepSeekAnthropicBaseUrl = (baseUrl) => {
  const normalized = norm(baseUrl || 'https://api.deepseek.com').replace(
    /\/v1$/,
    '',
  )
  try {
    const url = new URL(normalized)
    const path = url.pathname.replace(/\/$/, '')
    if (url.hostname === 'api.deepseek.com' && path === '') {
      return `${normalized}/anthropic`
    }
  } catch {
    return normalized
  }
  return normalized
}

const STUB_OPEN = {
  type: 'object',
  properties: {},
  additionalProperties: true,
}
const STUB_GEMINI = {
  type: 'object',
  properties: {
    args_json: {
      type: 'string',
      description:
        'JSON-encoded object of the real tool arguments. Use this only after yolo_local__tool_search has returned the full schema.',
    },
  },
  required: ['args_json'],
}

const TOOL_SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description:
        'Query to find tools. Use "select:<tool_name>" for exact loading.',
    },
    max_results: { type: 'integer' },
  },
  required: ['query'],
}

const STUB_DESC =
  'Create a new issue in a GitHub repository. (on-demand: call yolo_local__tool_search to load full schema before use)'

const SYSTEM_PROMPT =
  'You are an assistant. Some tools are registered in on-demand mode: their full input schema is not yet loaded. ' +
  'Before calling any on-demand tool you MUST first call yolo_local__tool_search with query "select:<tool_name>" ' +
  'to retrieve the real schema. Never invent arguments for on-demand tools.'

const USER_PROMPT =
  'Please create a GitHub issue titled "hello" in repo owner/repo.'

// ---------- Anthropic ----------
async function testAnthropic() {
  const p = findProvider('DeepSeek')
  if (!p) return { skipped: 'DeepSeek provider missing' }
  const model = 'deepseek-v4-flash'
  const url = `${deepSeekAnthropicBaseUrl(p.baseUrl)}/v1/messages`
  const body = {
    model,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: USER_PROMPT }],
    tools: [
      {
        name: 'yolo_local__tool_search',
        description: 'Load full schemas for on-demand tools.',
        input_schema: TOOL_SEARCH_SCHEMA,
      },
      {
        name: 'github__create_issue',
        description: STUB_DESC,
        input_schema: STUB_OPEN,
      },
    ],
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': p.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return analyze('anthropic', res.status, text, (json) => {
    const blocks = json.content ?? []
    return {
      stop_reason: json.stop_reason,
      tool_uses: blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ name: b.name, input: b.input })),
      text: blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .slice(0, 200),
    }
  })
}

// ---------- OpenAI Chat Completions ----------
async function testOpenAIChat() {
  const p = findProvider('Moonshot') ?? findProvider('小米渠道')
  if (!p) return { skipped: 'no openai-compatible provider with key' }
  const model = p.id === 'Moonshot' ? 'moonshot-v1-8k' : 'gpt-4o-mini'
  const base =
    norm(p.baseUrl) || (p.id === 'Moonshot' ? 'https://api.moonshot.cn/v1' : '')
  const url = `${base}/chat/completions`
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'yolo_local__tool_search',
          description: 'Load full schemas for on-demand tools.',
          parameters: TOOL_SEARCH_SCHEMA,
        },
      },
      {
        type: 'function',
        function: {
          name: 'github__create_issue',
          description: STUB_DESC,
          parameters: STUB_OPEN,
        },
      },
    ],
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${p.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return analyze('openai-chat', res.status, text, (json) => {
    const msg = json.choices?.[0]?.message
    return {
      finish_reason: json.choices?.[0]?.finish_reason,
      tool_calls: (msg?.tool_calls ?? []).map((c) => ({
        name: c.function?.name,
        args: c.function?.arguments,
      })),
      content: (msg?.content ?? '').slice(0, 200),
    }
  })
}

// ---------- OpenAI Responses (OpenRouter) ----------
async function testOpenAIResponses() {
  const p = findProvider('OpenRouter')
  if (!p) return { skipped: 'OpenRouter provider missing' }
  // OpenRouter exposes /chat/completions; "responses" path uses
  // their OpenAI passthrough. We hit /chat/completions here because
  // OpenRouter is not a real Responses backend; the project's
  // openai-responses apiType is only meaningful for openai.com.
  // To genuinely exercise Responses we'd need an OpenAI key.
  const model = 'openai/gpt-4o-mini'
  const url = `${norm(p.baseUrl)}/chat/completions`
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_PROMPT },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'yolo_local__tool_search',
          description: 'Load full schemas for on-demand tools.',
          parameters: TOOL_SEARCH_SCHEMA,
        },
      },
      {
        type: 'function',
        function: {
          name: 'github__create_issue',
          description: STUB_DESC,
          parameters: STUB_OPEN,
        },
      },
    ],
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${p.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return analyze(
    'openai-responses (via OpenRouter chat)',
    res.status,
    text,
    (json) => {
      const msg = json.choices?.[0]?.message
      return {
        finish_reason: json.choices?.[0]?.finish_reason,
        tool_calls: (msg?.tool_calls ?? []).map((c) => ({
          name: c.function?.name,
          args: c.function?.arguments,
        })),
        content: (msg?.content ?? '').slice(0, 200),
      }
    },
  )
}

// ---------- Gemini ----------
async function testGemini() {
  const p = findProvider('测试aisudiuio')
  if (!p) return { skipped: '测试aisudiuio provider missing' }
  const model = 'gemini-2.5-flash'
  const url = `${norm(p.baseUrl)}/v1beta/models/${model}:generateContent?key=${p.apiKey}`
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: USER_PROMPT }] }],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'yolo_local__tool_search',
            description: 'Load full schemas for on-demand tools.',
            parameters: TOOL_SEARCH_SCHEMA,
          },
          {
            name: 'github__create_issue',
            description: STUB_DESC,
            parameters: STUB_GEMINI,
          },
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return analyze('gemini', res.status, text, (json) => {
    const parts = json.candidates?.[0]?.content?.parts ?? []
    return {
      finish_reason: json.candidates?.[0]?.finishReason,
      function_calls: parts
        .filter((p) => p.functionCall)
        .map((p) => ({ name: p.functionCall.name, args: p.functionCall.args })),
      text: parts
        .filter((p) => p.text)
        .map((p) => p.text)
        .join('\n')
        .slice(0, 200),
    }
  })
}

function analyze(label, status, text, extract) {
  const ok = status >= 200 && status < 300
  let json
  try {
    json = JSON.parse(text)
  } catch {
    return { label, status, ok, error: text.slice(0, 400) }
  }
  if (!ok) {
    return {
      label,
      status,
      ok,
      error:
        json.error?.message ?? JSON.stringify(json.error ?? json).slice(0, 400),
    }
  }
  return { label, status, ok, ...extract(json) }
}

const fns = {
  anthropic: testAnthropic,
  'openai-chat': testOpenAIChat,
  'openai-responses': testOpenAIResponses,
  gemini: testGemini,
}

async function main() {
  const targets = target === 'all' ? Object.keys(fns) : [target]
  for (const t of targets) {
    if (!fns[t]) {
      console.log(`-- unknown: ${t}`)
      continue
    }
    process.stdout.write(`-- ${t} ... `)
    try {
      const r = await fns[t]()
      console.log()
      console.dir(r, { depth: 4 })
    } catch (e) {
      console.log('THREW')
      console.log(e?.message ?? e)
    }
    console.log()
  }
}

main()
