/**
 * Per-row symmetric scalar quantization to int8, with a per-row float32
 * scale (`scale_i = max_j |x_ij|`). Vectors held in the in-memory
 * `VectorIndex` are always L2-normalized (component magnitudes <= 1), so
 * scaling against each row's own max-magnitude component — rather than a
 * fixed global scale — keeps the full int8 range in use for every row
 * regardless of how "spread out" its components are.
 *
 * Reconstruction: `x_ij ≈ q_ij * scale_i / 127`. Per-component error is
 * bounded by `scale_i / 254` (half a quantization step); dot-product error
 * against a unit query vector is bounded by `‖query‖₁ * scale_i / 254`.
 *
 * Pure function: writes `vector.length` quantized components into `out`
 * starting at `offset` and returns the row's scale. Does not read or
 * mutate any other state, so it stays trivially unit-testable and safe to
 * call from `VectorIndex.append`/`compact` without any knowledge of the
 * index's own bookkeeping.
 */
export function quantizeRowInt8(
  vector: Float32Array,
  out: Int8Array,
  offset: number,
): number {
  let maxAbs = 0
  for (let i = 0; i < vector.length; i++) {
    const abs = Math.abs(vector[i])
    if (abs > maxAbs) maxAbs = abs
  }
  // The zero vector can't be scaled against its own (zero) max magnitude;
  // any positive scale quantizes it to all-zero components, so `1` is an
  // arbitrary but safe choice that just avoids a division by zero.
  const scale = maxAbs === 0 ? 1 : maxAbs
  for (let i = 0; i < vector.length; i++) {
    out[offset + i] = Math.round((vector[i] / scale) * 127)
  }
  return scale
}
