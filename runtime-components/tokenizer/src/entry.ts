import { encode } from 'gpt-tokenizer/encoding/cl100k_base'

type TokenizerApi = Readonly<{
  count(text: string): number
  dispose(): void
}>

globalThis.__yolo_register_runtime_component__({
  id: 'tokenizer',
  create(): TokenizerApi {
    return Object.freeze({
      count(text: string): number {
        if (typeof text !== 'string') {
          throw new TypeError('Tokenizer input must be a string')
        }
        return encode(text).length
      },
      dispose(): void {
        // The tokenizer owns no external resources.
      },
    })
  },
})
