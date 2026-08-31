import { quantizeRowInt8 } from './quantization'

describe('quantizeRowInt8', () => {
  it('round-trips within the scale/254 error bound', () => {
    const vector = new Float32Array([0.7, -0.3, 0.1, -0.9, 0.5])
    const out = new Int8Array(vector.length)
    const scale = quantizeRowInt8(vector, out, 0)

    const maxAbs = Math.max(...[...vector].map(Math.abs))
    expect(scale).toBeCloseTo(maxAbs)

    const errorBound = scale / 254
    for (let i = 0; i < vector.length; i++) {
      const reconstructed = (out[i] * scale) / 127
      expect(Math.abs(reconstructed - vector[i])).toBeLessThanOrEqual(
        errorBound + 1e-6,
      )
    }
  })

  it('gives the zero vector scale 1 and all-zero components', () => {
    const vector = new Float32Array([0, 0, 0])
    const out = new Int8Array(vector.length)
    const scale = quantizeRowInt8(vector, out, 0)

    expect(scale).toBe(1)
    expect([...out]).toEqual([0, 0, 0])
  })

  it('computes scale as the row max absolute component', () => {
    const vector = new Float32Array([0.2, -0.6, 0.4])
    const out = new Int8Array(vector.length)
    const scale = quantizeRowInt8(vector, out, 0)

    expect(scale).toBeCloseTo(0.6)
  })

  it('quantizes the max-magnitude component to +-127 (full int8 range)', () => {
    const vector = new Float32Array([1, -1, 0.5])
    const out = new Int8Array(vector.length)
    quantizeRowInt8(vector, out, 0)

    expect(out[0]).toBe(127)
    expect(out[1]).toBe(-127)
  })

  it('writes at the given offset without touching earlier rows', () => {
    const out = new Int8Array(6)
    quantizeRowInt8(new Float32Array([1, -1, 0.5]), out, 0)
    quantizeRowInt8(new Float32Array([-1, 1, 0]), out, 3)

    expect(out[0]).toBe(127)
    expect(out[3]).toBe(-127)
    expect(out[4]).toBe(127)
    expect(out[5]).toBe(0)
  })
})
