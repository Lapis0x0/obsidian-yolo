declare const __PGLITE_POSTGRES_DATA__: string
declare const __PGLITE_POSTGRES_WASM__: string
declare const __PGLITE_VECTOR_TAR__: string

declare module '*.svg' {
  const dataUrl: string
  export default dataUrl
}

declare module '*.md' {
  const text: string
  export default text
}
