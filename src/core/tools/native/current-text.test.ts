/* eslint-disable import/no-nodejs-modules -- real filesystem reads against a temp directory */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
/* eslint-enable import/no-nodejs-modules */

import { MAX_FILE_SIZE_BYTES } from '../tool-args'

import { readNativeCurrentText } from './current-text'

describe('readNativeCurrentText', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'yolo-current-text-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the text of a small text file', async () => {
    const path = join(dir, 'a.md')
    await writeFile(path, 'hello\nworld\n')
    await expect(readNativeCurrentText(path)).resolves.toEqual({
      state: 'text',
      text: 'hello\nworld\n',
    })
  })

  it('reports a missing file as absent', async () => {
    await expect(readNativeCurrentText(join(dir, 'nope.md'))).resolves.toEqual({
      state: 'absent',
    })
  })

  it('reports binary files, directories and oversized files as unreadable', async () => {
    const binary = join(dir, 'b.bin')
    await writeFile(binary, new Uint8Array([104, 0, 105]))
    const large = join(dir, 'large.md')
    await writeFile(large, 'x'.repeat(MAX_FILE_SIZE_BYTES + 1))

    await expect(readNativeCurrentText(binary)).resolves.toEqual({
      state: 'unreadable',
    })
    await expect(readNativeCurrentText(dir)).resolves.toEqual({
      state: 'unreadable',
    })
    await expect(readNativeCurrentText(large)).resolves.toEqual({
      state: 'unreadable',
    })
  })
})
