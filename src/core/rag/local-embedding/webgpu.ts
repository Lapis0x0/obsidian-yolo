type GpuAdapterLike = Readonly<{
  features: Readonly<{ has(feature: string): boolean }>
}>
type GpuLike = Readonly<{
  requestAdapter(): Promise<GpuAdapterLike | null>
}>

/**
 * Whether this machine can run fp16 local embedding models on WebGPU: an
 * adapter has to exist and support `shader-f16`. Backs both the settings
 * shelf's GPU tab (disabled when false) and the session client's device
 * choice, so the two never disagree.
 */
export async function isLocalEmbeddingGpuSupported(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) return false
  try {
    const adapter = await gpu.requestAdapter()
    return adapter?.features.has('shader-f16') ?? false
  } catch {
    return false
  }
}
