import {
  buildBedrockEmbeddingRequestBody,
  isSupportedBedrockEmbeddingModel,
} from './bedrock'

describe('bedrock utils', () => {
  it('recognizes supported Bedrock embedding model families', () => {
    expect(
      isSupportedBedrockEmbeddingModel('amazon.titan-embed-text-v2:0'),
    ).toBe(true)
    expect(isSupportedBedrockEmbeddingModel('cohere.embed-english-v3')).toBe(
      true,
    )
    expect(
      isSupportedBedrockEmbeddingModel('some-future.embedding-family-v1'),
    ).toBe(false)
  })

  it('builds a Titan embedding request body', () => {
    expect(
      buildBedrockEmbeddingRequestBody(
        'amazon.titan-embed-text-v2:0',
        'hello',
      ),
    ).toEqual({
      inputText: 'hello',
    })
  })

  it('builds a Cohere embedding request body', () => {
    expect(
      buildBedrockEmbeddingRequestBody('cohere.embed-english-v3', 'hello'),
    ).toEqual({
      texts: ['hello'],
      input_type: 'search_document',
      embedding_types: ['float'],
    })
  })

  it('rejects unsupported Bedrock embedding families clearly', () => {
    expect(() =>
      buildBedrockEmbeddingRequestBody('unsupported.embedding-model', 'hello'),
    ).toThrow('Embedding is not yet supported')
  })
})
