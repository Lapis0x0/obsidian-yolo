import * as JSZipModule from 'jszip'

type JSZipConstructor = typeof import('jszip')

const JSZip =
  (JSZipModule as unknown as { default?: JSZipConstructor }).default ??
  JSZipModule

import { parseOfficeDocument } from './index'

async function buildZip(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip()
  Object.entries(files).forEach(([path, content]) => {
    zip.file(path, content)
  })
  return zip.generateAsync({ type: 'uint8array' })
}

describe('parseOfficeDocument docx', () => {
  it('extracts paragraphs', async () => {
    const data = await buildZip({
      'word/document.xml': `<w:document><w:body>
        <w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>
        <w:p><w:r><w:t>Second </w:t></w:r><w:r><w:t>paragraph</w:t></w:r></w:p>
        <w:p><w:r><w:t>Third &amp; final</w:t></w:r></w:p>
      </w:body></w:document>`,
    })

    await expect(parseOfficeDocument(data, 'docx')).resolves.toEqual({
      markdown: 'First paragraph\n\nSecond paragraph\n\nThird & final',
      metadata: { kind: 'docx', paragraphCount: 3 },
    })
  })

  it('handles empty documents', async () => {
    const data = await buildZip({
      'word/document.xml': '<w:document><w:body></w:body></w:document>',
    })

    await expect(parseOfficeDocument(data, 'docx')).resolves.toEqual({
      markdown: '',
      metadata: { kind: 'docx', paragraphCount: 0 },
    })
  })

  it('throws for damaged zip data', async () => {
    await expect(
      parseOfficeDocument(new Uint8Array([1, 2, 3]), 'docx'),
    ).rejects.toThrow('Failed to read Office document zip')
  })
})

describe('parseOfficeDocument pptx', () => {
  it('extracts slides in numeric order', async () => {
    const data = await buildZip({
      'ppt/slides/slide2.xml': `<p:sld><p:cSld><p:spTree>
        <p:sp><p:txBody><a:p><a:r><a:t>Slide 2 title</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:txBody><a:p><a:r><a:t>Slide 2 body</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
      'ppt/slides/slide1.xml': `<p:sld><p:cSld><p:spTree>
        <p:sp><p:txBody><a:p><a:r><a:t>Slide 1 title</a:t></a:r></a:p></p:txBody></p:sp>
        <p:sp><p:txBody><a:p><a:r><a:t>Slide 1 body</a:t></a:r></a:p></p:txBody></p:sp>
      </p:spTree></p:cSld></p:sld>`,
    })

    await expect(parseOfficeDocument(data, 'pptx')).resolves.toEqual({
      markdown:
        '<!-- Slide number: 1 -->\nSlide 1 title\n\nSlide 1 body\n\n<!-- Slide number: 2 -->\nSlide 2 title\n\nSlide 2 body',
      metadata: { kind: 'pptx', slideCount: 2 },
    })
  })

  it('handles empty documents', async () => {
    const data = await buildZip({})

    await expect(parseOfficeDocument(data, 'pptx')).resolves.toEqual({
      markdown: '',
      metadata: { kind: 'pptx', slideCount: 0 },
    })
  })

  it('throws for damaged zip data', async () => {
    await expect(
      parseOfficeDocument(new Uint8Array([1, 2, 3]), 'pptx'),
    ).rejects.toThrow('Failed to read Office document zip')
  })
})

describe('parseOfficeDocument xlsx', () => {
  it('renders sheets as markdown tables and uses stored formula values', async () => {
    const data = await buildZip({
      'xl/workbook.xml': `<workbook><sheets>
        <sheet name="Budget" sheetId="1" r:id="rId1" />
        <sheet name="Summary" sheetId="2" r:id="rId2" />
      </sheets></workbook>`,
      'xl/sharedStrings.xml': `<sst>
        <si><t>Item</t></si>
        <si><t>Count</t></si>
        <si><t>Total</t></si>
        <si><t>Apples</t></si>
        <si><t>Done</t></si>
      </sst>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
        <row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>2</v></c><c r="C2"><f>B2*10</f><v>20</v></c></row>
        <row r="3"><c r="A3"><f>B3*10</f></c></row>
      </sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': `<worksheet><sheetData>
        <row r="1"><c r="A1" t="s"><v>4</v></c></row>
      </sheetData></worksheet>`,
    })

    await expect(parseOfficeDocument(data, 'xlsx')).resolves.toEqual({
      markdown:
        '## Budget\n\n| Item | Count | Total |\n| --- | --- | --- |\n| Apples | 2 | 20 |\n|  |  |  |\n\n## Summary\n\n| Done |\n| --- |',
      metadata: {
        kind: 'xlsx',
        sheetCount: 2,
        sheetNames: ['Budget', 'Summary'],
      },
    })
  })

  it('handles empty documents', async () => {
    const data = await buildZip({
      'xl/workbook.xml': '<workbook><sheets></sheets></workbook>',
    })

    await expect(parseOfficeDocument(data, 'xlsx')).resolves.toEqual({
      markdown: '',
      metadata: { kind: 'xlsx', sheetCount: 0, sheetNames: [] },
    })
  })

  it('reads inline strings (t="inlineStr")', async () => {
    const data = await buildZip({
      'xl/workbook.xml': `<workbook><sheets>
        <sheet name="Inline" sheetId="1" r:id="rId1" />
      </sheets></workbook>`,
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>Plain inline</t></is></c><c r="B1" t="inlineStr"><is><r><t>Rich </t></r><r><t>inline</t></r></is></c></row>
      </sheetData></worksheet>`,
    })

    await expect(parseOfficeDocument(data, 'xlsx')).resolves.toEqual({
      markdown: '## Inline\n\n| Plain inline | Rich inline |\n| --- | --- |',
      metadata: { kind: 'xlsx', sheetCount: 1, sheetNames: ['Inline'] },
    })
  })

  it('throws for damaged zip data', async () => {
    await expect(
      parseOfficeDocument(new Uint8Array([1, 2, 3]), 'xlsx'),
    ).rejects.toThrow('Failed to read Office document zip')
  })
})
