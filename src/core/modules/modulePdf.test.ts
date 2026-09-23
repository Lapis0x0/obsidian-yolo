import type { PdfDocumentHandle } from '../../utils/pdf/pdfDocumentCache'

import { ModuleLifecycleScope } from './lifecycleScope'
import { ModulePdfCapabilityProvider } from './modulePdf'

function fakeHandle(path: string, releases: string[]): PdfDocumentHandle {
  return {
    path,
    pageCount: 1,
    getPage: () => Promise.reject(new Error('not used')),
    isStale: () => false,
    subscribe: () => () => undefined,
    release: () => releases.push(path),
  }
}

const unusedAddAnnotations = () => Promise.reject(new Error('not used'))

describe('ModulePdfCapabilityProvider', () => {
  it('releases every handle a module still holds when it unloads', async () => {
    const releases: string[] = []
    const opened: string[] = []
    const provider = new ModulePdfCapabilityProvider(
      () => ({
        open: async (path) => {
          opened.push(path)
          return fakeHandle(path, releases)
        },
      }),
      unusedAddAnnotations,
    )
    const lifecycle = new ModuleLifecycleScope()
    const { api } = provider.create('reader', lifecycle)

    const kept = await api.open('Papers/a.pdf')
    const dropped = await api.open('Papers\\b.pdf')
    dropped.release()
    expect(opened).toEqual(['Papers/a.pdf', 'Papers/b.pdf'])
    expect(kept.path).toBe('Papers/a.pdf')

    lifecycle.dispose()
    expect(releases).toEqual(['Papers/b.pdf', 'Papers/a.pdf'])
    await expect(api.open('Papers/a.pdf')).rejects.toThrow('not active')
  })

  it('rejects paths outside the vault', async () => {
    const provider = new ModulePdfCapabilityProvider(
      () => ({ open: () => Promise.reject(new Error('unreachable')) }),
      unusedAddAnnotations,
    )
    const { api } = provider.create('reader', new ModuleLifecycleScope())
    await expect(api.open('../outside.pdf')).rejects.toThrow('dot segments')
  })

  it('hands annotations to the engine and returns exactly its bytes', async () => {
    const calls: { bytes: number[]; count: number }[] = []
    const provider = new ModulePdfCapabilityProvider(
      () => ({ open: () => Promise.reject(new Error('unreachable')) }),
      async (bytes, annotations) => {
        calls.push({ bytes: Array.from(bytes), count: annotations.length })
        // A view into a larger buffer: only the view is the output.
        return new Uint8Array([9, 7, 7, 9, 9]).subarray(1, 4)
      },
    )
    const lifecycle = new ModuleLifecycleScope()
    const { api } = provider.create('reader', lifecycle)
    const source = new Uint8Array([1, 2, 3]).buffer
    const output = await api.addAnnotations(source, [
      { type: 'highlight', page: 1, quadPoints: [], color: '#ffff00' },
    ])
    expect(Array.from(new Uint8Array(output))).toEqual([7, 7, 9])
    expect(calls).toEqual([{ bytes: [1, 2, 3], count: 1 }])

    lifecycle.dispose()
    await expect(api.addAnnotations(source, [])).rejects.toThrow('not active')
  })
})
