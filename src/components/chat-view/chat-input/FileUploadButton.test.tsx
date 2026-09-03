import { renderToStaticMarkup } from 'react-dom/server'

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({ t: (_key: string, fallback: string) => fallback }),
}))

import { FileUploadButton } from './FileUploadButton'

describe('FileUploadButton', () => {
  it('includes images for runtimes that accept them', () => {
    const html = renderToStaticMarkup(<FileUploadButton onUpload={() => {}} />)

    expect(html).toContain('accept="image/*,application/pdf')
  })

  it('keeps document attachments while excluding images for Grok', () => {
    const html = renderToStaticMarkup(
      <FileUploadButton allowImages={false} onUpload={() => {}} />,
    )

    expect(html).toContain('accept="application/pdf')
    expect(html).not.toContain('image/*')
  })
})
