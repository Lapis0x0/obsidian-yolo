import * as JSZipModule from 'jszip'

type JSZipConstructor = typeof import('jszip')
type JSZipInstance = InstanceType<JSZipConstructor>

const JSZip =
  (JSZipModule as unknown as { default?: JSZipConstructor }).default ??
  JSZipModule

export async function loadOfficeZip(
  data: ArrayBuffer | Uint8Array,
): Promise<JSZipInstance> {
  try {
    return await JSZip.loadAsync(data)
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to read Office document zip: ${error.message}`)
    }
    throw new Error(
      `Failed to read Office document zip: ${typeof error === 'string' ? error : JSON.stringify(error)}`,
    )
  }
}

export async function readZipText(
  zip: JSZipInstance,
  path: string,
): Promise<string> {
  const file = zip.file(path)
  if (!file) {
    throw new Error(`Office document is missing required file: ${path}`)
  }
  return file.async('text')
}
