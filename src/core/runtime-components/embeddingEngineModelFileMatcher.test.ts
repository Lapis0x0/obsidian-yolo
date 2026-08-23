/**
 * `matchDeclaredModelFile` lives under `runtime-components/`, which is
 * outside Jest's `roots` (see `bashEngineReadOnly.test.ts` for why) — this
 * imports it directly by relative path, same as that file does for
 * `bash-engine`'s `entry.ts`.
 *
 * Regression coverage for the bug Codex's review caught in the original
 * `worker.ts`: a naive `url.endsWith(name)` customCache match hands back
 * `config.json`'s bytes for a `tokenizer_config.json` request, because
 * `"tokenizer_config.json".endsWith("config.json")` is true. Transformers.js
 * 3.8.1 always loads both files, so this silently fed the wrong file to the
 * tokenizer.
 */
import { matchDeclaredModelFile } from '../../../runtime-components/embedding-engine/src/modelFileMatcher'

const DECLARED = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
  'onnx/model_quantized.onnx',
] as const

describe('matchDeclaredModelFile', () => {
  it('does not let tokenizer_config.json shadow config.json (the regression)', () => {
    expect(
      matchDeclaredModelFile(
        '/models/yolo-local-embedding-model/tokenizer_config.json',
        DECLARED,
      ),
    ).toBe('tokenizer_config.json')
    expect(
      matchDeclaredModelFile(
        '/models/yolo-local-embedding-model/config.json',
        DECLARED,
      ),
    ).toBe('config.json')
  })

  it('matches a local-path candidate', () => {
    expect(
      matchDeclaredModelFile(
        '/models/yolo-local-embedding-model/onnx/model_quantized.onnx',
        DECLARED,
      ),
    ).toBe('onnx/model_quantized.onnx')
  })

  it('matches a remote HF-style URL candidate', () => {
    expect(
      matchDeclaredModelFile(
        'https://huggingface.co/yolo-local-embedding-model/resolve/main/tokenizer.json',
        DECLARED,
      ),
    ).toBe('tokenizer.json')
  })

  it('strips a query string and fragment before matching', () => {
    expect(
      matchDeclaredModelFile(
        'https://huggingface.co/yolo-local-embedding-model/resolve/main/config.json?download=true#frag',
        DECLARED,
      ),
    ).toBe('config.json')
  })

  it('URL-decodes the candidate before matching', () => {
    expect(
      matchDeclaredModelFile(
        '/models/yolo-local-embedding-model/special%5Ftokens_map.json',
        DECLARED,
      ),
    ).toBe('special_tokens_map.json')
  })

  it('returns undefined for a file that was never declared', () => {
    expect(
      matchDeclaredModelFile(
        '/models/yolo-local-embedding-model/vocab.txt',
        DECLARED,
      ),
    ).toBeUndefined()
  })

  it('matches a bare declared name with no path prefix at all', () => {
    expect(matchDeclaredModelFile('config.json', DECLARED)).toBe('config.json')
  })
})
