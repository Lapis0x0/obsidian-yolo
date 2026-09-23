import {
  isDeepSeekBaseUrl,
  isMistralBaseUrl,
  isMoonshotBaseUrl,
  isPerplexityBaseUrl,
  isReasoningContentBaseUrl,
  resolveAdapterForBaseUrl,
} from './baseUrlDetection'
import { DeepSeekMessageAdapter } from './deepseekMessageAdapter'
import { KimiMessageAdapter } from './kimiMessageAdapter'
import { MistralMessageAdapter } from './mistralMessageAdapter'
import { OpenAIMessageAdapter } from './openaiMessageAdapter'
import { PerplexityMessageAdapter } from './perplexityMessageAdapter'
import { ReasoningContentMessageAdapter } from './reasoningContentMessageAdapter'

describe('isDeepSeekBaseUrl', () => {
  it('returns true for api.deepseek.com', () => {
    expect(isDeepSeekBaseUrl('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekBaseUrl('https://api.deepseek.com/v1')).toBe(true)
  })

  it('returns true for subdomains of deepseek.com', () => {
    expect(isDeepSeekBaseUrl('https://proxy.deepseek.com')).toBe(true)
  })

  it('returns false for undefined or empty', () => {
    expect(isDeepSeekBaseUrl(undefined)).toBe(false)
    expect(isDeepSeekBaseUrl('')).toBe(false)
  })

  it('returns false for unrelated URLs', () => {
    expect(isDeepSeekBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isDeepSeekBaseUrl('https://example.com')).toBe(false)
  })

  it('returns false when deepseek.com appears only in path or query', () => {
    expect(isDeepSeekBaseUrl('https://evil.com/redirect?to=deepseek.com')).toBe(
      false,
    )
    expect(isDeepSeekBaseUrl('https://evil.com/deepseek.com/path')).toBe(false)
  })
})

describe('isMoonshotBaseUrl', () => {
  it('returns true for api.moonshot.cn', () => {
    expect(isMoonshotBaseUrl('https://api.moonshot.cn')).toBe(true)
    expect(isMoonshotBaseUrl('https://api.moonshot.cn/v1')).toBe(true)
  })

  it('returns true for subdomains of moonshot.cn', () => {
    expect(isMoonshotBaseUrl('https://proxy.moonshot.cn')).toBe(true)
  })

  it('returns false for undefined or empty', () => {
    expect(isMoonshotBaseUrl(undefined)).toBe(false)
    expect(isMoonshotBaseUrl('')).toBe(false)
  })

  it('returns false for unrelated URLs', () => {
    expect(isMoonshotBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('returns false when moonshot.cn appears only in path or query', () => {
    expect(isMoonshotBaseUrl('https://evil.com/redirect?to=moonshot.cn')).toBe(
      false,
    )
  })
})

describe('isMistralBaseUrl', () => {
  it('returns true for api.mistral.ai', () => {
    expect(isMistralBaseUrl('https://api.mistral.ai')).toBe(true)
    expect(isMistralBaseUrl('https://api.mistral.ai/v1')).toBe(true)
  })

  it('returns true for subdomains of mistral.ai', () => {
    expect(isMistralBaseUrl('https://proxy.mistral.ai')).toBe(true)
  })

  it('returns false for undefined or empty', () => {
    expect(isMistralBaseUrl(undefined)).toBe(false)
    expect(isMistralBaseUrl('')).toBe(false)
  })

  it('returns false for unrelated URLs', () => {
    expect(isMistralBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('returns false when mistral.ai appears only in path or query', () => {
    expect(isMistralBaseUrl('https://evil.com/redirect?to=mistral.ai')).toBe(
      false,
    )
  })
})

describe('isPerplexityBaseUrl', () => {
  it('returns true for api.perplexity.ai', () => {
    expect(isPerplexityBaseUrl('https://api.perplexity.ai')).toBe(true)
    expect(isPerplexityBaseUrl('https://api.perplexity.ai/v1')).toBe(true)
  })

  it('returns true for subdomains of perplexity.ai', () => {
    expect(isPerplexityBaseUrl('https://proxy.perplexity.ai')).toBe(true)
  })

  it('returns false for undefined or empty', () => {
    expect(isPerplexityBaseUrl(undefined)).toBe(false)
    expect(isPerplexityBaseUrl('')).toBe(false)
  })

  it('returns false for unrelated URLs', () => {
    expect(isPerplexityBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('returns false when perplexity.ai appears only in path or query', () => {
    expect(
      isPerplexityBaseUrl('https://evil.com/redirect?to=perplexity.ai'),
    ).toBe(false)
  })
})

describe('resolveAdapterForBaseUrl', () => {
  it('returns DeepSeekMessageAdapter for DeepSeek URLs', () => {
    expect(resolveAdapterForBaseUrl('https://api.deepseek.com')).toBeInstanceOf(
      DeepSeekMessageAdapter,
    )
  })

  it('returns KimiMessageAdapter for Moonshot URLs', () => {
    expect(
      resolveAdapterForBaseUrl('https://api.moonshot.cn/v1'),
    ).toBeInstanceOf(KimiMessageAdapter)
  })

  it('returns MistralMessageAdapter for Mistral URLs', () => {
    expect(
      resolveAdapterForBaseUrl('https://api.mistral.ai/v1'),
    ).toBeInstanceOf(MistralMessageAdapter)
  })

  it('returns PerplexityMessageAdapter for Perplexity URLs', () => {
    expect(
      resolveAdapterForBaseUrl('https://api.perplexity.ai'),
    ).toBeInstanceOf(PerplexityMessageAdapter)
  })

  it('returns OpenAIMessageAdapter for unknown URLs', () => {
    expect(
      resolveAdapterForBaseUrl('https://api.openai.com/v1'),
    ).toBeInstanceOf(OpenAIMessageAdapter)
  })

  it('returns OpenAIMessageAdapter for undefined', () => {
    expect(resolveAdapterForBaseUrl(undefined)).toBeInstanceOf(
      OpenAIMessageAdapter,
    )
  })
})

describe('isReasoningContentBaseUrl', () => {
  it('matches GLM, Qwen, and SiliconFlow hosts', () => {
    expect(
      isReasoningContentBaseUrl('https://open.bigmodel.cn/api/paas/v4'),
    ).toBe(true)
    expect(isReasoningContentBaseUrl('https://api.z.ai/api/paas/v4')).toBe(true)
    expect(
      isReasoningContentBaseUrl(
        'https://dashscope.aliyuncs.com/compatible-mode/v1',
      ),
    ).toBe(true)
    expect(
      isReasoningContentBaseUrl(
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      ),
    ).toBe(true)
    expect(isReasoningContentBaseUrl('https://api.siliconflow.cn/v1')).toBe(
      true,
    )
  })

  it('does not match lookalike or unrelated hosts', () => {
    expect(isReasoningContentBaseUrl('https://notz.ai/v1')).toBe(false)
    expect(isReasoningContentBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isReasoningContentBaseUrl(undefined)).toBe(false)
  })

  it('resolves the reasoning_content adapter for them', () => {
    expect(
      resolveAdapterForBaseUrl('https://open.bigmodel.cn/api/paas/v4'),
    ).toBeInstanceOf(ReasoningContentMessageAdapter)
  })
})
