declare module 'virtual:pdfjs-worker-script' {
  const source: string
  export default source
}

declare module 'virtual:pdfjs-binary-data' {
  /** pdf.js binary-data kind (`standardFontDataUrl`, `wasmUrl`) -> file name -> base64 bytes. */
  const files: Readonly<Record<string, Readonly<Record<string, string>>>>
  export default files
}
