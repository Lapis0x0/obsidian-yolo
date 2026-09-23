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

describe('ModulePdfCapabilityProvider', () => {
  it('releases every handle a module still holds when it unloads', async () => {
    const releases: string[] = []
    const opened: string[] = []
    const provider = new ModulePdfCapabilityProvider(() => ({
      open: async (path) => {
        opened.push(path)
        return fakeHandle(path, releases)
      },
    }))
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
    const provider = new ModulePdfCapabilityProvider(() => ({
      open: () => Promise.reject(new Error('unreachable')),
    }))
    const { api } = provider.create('reader', new ModuleLifecycleScope())
    await expect(api.open('../outside.pdf')).rejects.toThrow('dot segments')
  })
})
