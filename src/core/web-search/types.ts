import { z } from 'zod'

export type WebSearchResultItem = {
  title: string
  url: string
  text: string
  // Short id (assigned by tool factory) so the model can cite via [citation,domain](id)
  id?: string
}

export type WebSearchResult = {
  answer?: string
  items: WebSearchResultItem[]
}

export type WebSearchScrapeResult = {
  url: string
  content: string
  title?: string
}

export const WEB_SEARCH_PROVIDER_TYPES = [
  'tavily',
  'jina',
  'searxng',
  'bing',
  'gemini-grounding',
  'grok',
] as const
export type WebSearchProviderType = (typeof WEB_SEARCH_PROVIDER_TYPES)[number]

const baseFields = {
  id: z.string().min(1),
  name: z.string().min(1),
}

export const tavilyOptionsSchema = z.object({
  ...baseFields,
  type: z.literal('tavily'),
  apiKey: z.string().default(''),
  depth: z.enum(['basic', 'advanced']).default('advanced'),
})

export const jinaOptionsSchema = z.object({
  ...baseFields,
  type: z.literal('jina'),
  apiKey: z.string().default(''),
  searchUrl: z.string().default('https://s.jina.ai/'),
  scrapeUrl: z.string().default('https://r.jina.ai/'),
})

export const searxngOptionsSchema = z.object({
  ...baseFields,
  type: z.literal('searxng'),
  baseUrl: z.string().min(1),
  language: z.string().default('auto'),
  engines: z.array(z.string()).default([]),
  username: z.string().default(''),
  password: z.string().default(''),
})

export const bingOptionsSchema = z.object({
  ...baseFields,
  type: z.literal('bing'),
})

export const geminiGroundingOptionsSchema = z.object({
  ...baseFields,
  type: z.literal('gemini-grounding'),
  apiKey: z.string().default(''),
  model: z.string().default('gemini-2.5-flash'),
  baseUrl: z.string().default('https://generativelanguage.googleapis.com'),
})

export const grokSearchOptionsSchema = z.object({
  ...baseFields,
  type: z.literal('grok'),
  apiKey: z.string().default(''),
  model: z.string().default('grok-4-latest'),
  baseUrl: z.string().default('https://api.x.ai/v1/responses'),
  systemPrompt: z
    .string()
    .default(
      'You are a search engine. Return concise factual answers with citations.',
    ),
  enableX: z.boolean().default(true),
})

export const webSearchProviderOptionsSchema = z.discriminatedUnion('type', [
  tavilyOptionsSchema,
  jinaOptionsSchema,
  searxngOptionsSchema,
  bingOptionsSchema,
  geminiGroundingOptionsSchema,
  grokSearchOptionsSchema,
])
export type WebSearchProviderOptions = z.infer<
  typeof webSearchProviderOptionsSchema
>

export const webSearchCommonOptionsSchema = z.object({
  resultSize: z.number().int().min(1).max(50).default(8),
  searchTimeoutMs: z.number().int().min(1000).max(120000).default(15000),
  scrapeTimeoutMs: z.number().int().min(1000).max(120000).default(20000),
})
export type WebSearchCommonOptions = z.infer<
  typeof webSearchCommonOptionsSchema
>

export const webSearchSettingsSchema = z.object({
  providers: z
    .array(z.unknown())
    .transform((items): WebSearchProviderOptions[] =>
      items.flatMap((item) => {
        const parsed = webSearchProviderOptionsSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      }),
    )
    .catch([]),
  defaultProviderId: z.string().optional(),
  common: webSearchCommonOptionsSchema.catch({
    resultSize: 8,
    searchTimeoutMs: 15000,
    scrapeTimeoutMs: 20000,
  }),
})
export type WebSearchSettings = z.infer<typeof webSearchSettingsSchema>

export type WebSearchSearchInput = {
  query: string
  topic?: string
}

export type WebSearchScrapeInput = {
  url: string
}

export interface WebSearchProvider<
  T extends WebSearchProviderOptions = WebSearchProviderOptions,
> {
  readonly type: T['type']
  readonly displayName: string
  readonly supportsScrape: boolean
  search(
    input: WebSearchSearchInput,
    options: T,
    common: WebSearchCommonOptions,
    signal?: AbortSignal,
  ): Promise<WebSearchResult>
  scrape?(
    input: WebSearchScrapeInput,
    options: T,
    common: WebSearchCommonOptions,
    signal?: AbortSignal,
  ): Promise<WebSearchScrapeResult>
}

// Default options factory used when adding a new provider in the UI.
export function createDefaultProviderOptions(
  type: WebSearchProviderType,
  id: string,
): WebSearchProviderOptions {
  switch (type) {
    case 'tavily':
      return {
        id,
        name: 'Tavily',
        type: 'tavily',
        apiKey: '',
        depth: 'advanced',
      }
    case 'jina':
      return {
        id,
        name: 'Jina',
        type: 'jina',
        apiKey: '',
        searchUrl: 'https://s.jina.ai/',
        scrapeUrl: 'https://r.jina.ai/',
      }
    case 'searxng':
      return {
        id,
        name: 'SearXNG',
        type: 'searxng',
        baseUrl: '',
        language: 'auto',
        engines: [],
        username: '',
        password: '',
      }
    case 'bing':
      return { id, name: 'Bing', type: 'bing' }
    case 'gemini-grounding':
      return {
        id,
        name: 'Gemini Grounding',
        type: 'gemini-grounding',
        apiKey: '',
        model: 'gemini-2.5-flash',
        baseUrl: 'https://generativelanguage.googleapis.com',
      }
    case 'grok':
      return {
        id,
        name: 'Grok',
        type: 'grok',
        apiKey: '',
        model: 'grok-4-latest',
        baseUrl: 'https://api.x.ai/v1/responses',
        systemPrompt:
          'You are a search engine. Return concise factual answers with citations.',
        enableX: true,
      }
  }
}
