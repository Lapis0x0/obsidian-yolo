import {
  ModuleArtifactDownloadError,
  describeModuleFailure,
} from './moduleFailure'

describe('module failure diagnostics', () => {
  it('classifies a timeout across all official sources', () => {
    const error = new ModuleArtifactDownloadError('Learning manifest', [
      { source: 'Cloudflare Pages', error: 'request timed out' },
      { source: 'GitHub', error: 'request timed out' },
    ])

    expect(describeModuleFailure(error)).toEqual({
      kind: 'download-timeout',
      detail:
        'Learning manifest download failed from all official sources: Cloudflare Pages: request timed out; GitHub: request timed out',
    })
  })

  it('classifies integrity and mixed transport failures', () => {
    expect(
      describeModuleFailure(
        new ModuleArtifactDownloadError('Learning entry', [
          { source: 'Cloudflare Pages', error: 'SHA-256 mismatch' },
          { source: 'GitHub', error: 'HTTP 503' },
        ]),
      ).kind,
    ).toBe('integrity')
    expect(
      describeModuleFailure(
        new ModuleArtifactDownloadError('Learning entry', [
          { source: 'Cloudflare Pages', error: 'request timed out' },
          { source: 'GitHub', error: 'HTTP 503' },
        ]),
      ).kind,
    ).toBe('download')
  })
})
