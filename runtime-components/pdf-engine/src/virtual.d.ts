declare module 'virtual:pdfjs-worker-script' {
  const source: string
  export default source
}

declare module 'virtual:pdfjs-binary-data' {
  /** binary-data kind (`standardFontData`, `wasm`) -> file name -> base64 bytes. */
  const files: Readonly<Record<string, Readonly<Record<string, string>>>>
  export default files
}
