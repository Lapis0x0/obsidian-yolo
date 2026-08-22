import type { VectorMetaData } from '../../core/runtime-components/contracts'

import { quantizeRowInt8 } from './quantization'

const INITIAL_CAPACITY_ROWS = 1024
/** Compact once tombstoned rows exceed this fraction of the live matrix. */
const COMPACT_TOMBSTONE_RATIO = 0.25

export type VectorIndexRow = Readonly<{
  id: number
  path: string
  metadata: VectorMetaData
  /** Already L2-normalized. Length must equal the index's `dimension`. */
  vector: Float32Array
}>

/**
 * In-memory, per-embedding-model index: a flat row-major `Int8Array`
 * matrix plus a parallel `scales: Float32Array` (one float32 scale per
 * row) and parallel `ids`/`paths`/`metadata` arrays. This is the index's
 * only matrix representation — there is no float32 in-memory path, no
 * size threshold, and no platform branching: a 1536-dim model that would
 * cost ~6KB/row as float32 costs ~1.5KB/row here, which matters most on
 * memory-constrained mobile WebViews but is applied unconditionally
 * everywhere for a single, simplest-possible representation.
 *
 * Each row is quantized on `append` via `quantizeRowInt8` (per-row
 * symmetric scalar quantization: `scale_i = max_j |x_ij|`,
 * `q_ij = round(x_ij / scale_i * 127)`) — see `quantization.ts` for the
 * error bound. The on-disk `chunks` store is untouched by this: it keeps
 * the full-precision float32 vector as the lossless source of truth, and
 * `IndexedDbVectorStore.performSimilaritySearch` rescores int8 scan
 * candidates against those float32 vectors before returning an exact
 * similarity, so no query result is ever only as precise as int8.
 *
 * Deletions are tombstoned (not shifted) so in-flight scans stay valid;
 * once tombstones exceed {@link COMPACT_TOMBSTONE_RATIO} of the matrix,
 * `append` compacts them away.
 *
 * Not thread-safe / re-entrant across await points by design: callers must
 * only mutate between the yield boundaries of a query scan (see `topK.ts`),
 * matching the single-main-thread execution model this store runs under.
 */
export class VectorIndex {
  readonly dimension: number
  private capacityRows = 0
  size = 0
  matrix: Int8Array = new Int8Array(0)
  /** Per-row dequantization scale, parallel to `matrix`'s rows. */
  scales: Float32Array = new Float32Array(0)
  ids: number[] = []
  paths: string[] = []
  metadataList: VectorMetaData[] = []
  private tombstones: Uint8Array = new Uint8Array(0)
  tombstoneCount = 0
  /** path -> live (non-tombstoned) row indices. Used for path-scoped deletes. */
  readonly pathToRows = new Map<string, number[]>()
  private readonly idToRow = new Map<number, number>()
  lastQueryAt = Date.now()

  constructor(dimension: number) {
    this.dimension = dimension
  }

  isTombstoned(rowIndex: number): boolean {
    return this.tombstones[rowIndex] === 1
  }

  /** Idempotent: a repeat `append` for an id already present is a no-op. */
  append(row: VectorIndexRow): void {
    if (this.idToRow.has(row.id)) return
    if (row.vector.length !== this.dimension) {
      throw new Error(
        `Vector index dimension mismatch: expected ${this.dimension}, got ${row.vector.length}`,
      )
    }
    this.ensureCapacity(1)
    const rowIndex = this.size
    this.scales[rowIndex] = quantizeRowInt8(
      row.vector,
      this.matrix,
      rowIndex * this.dimension,
    )
    this.ids[rowIndex] = row.id
    this.paths[rowIndex] = row.path
    this.metadataList[rowIndex] = row.metadata
    this.tombstones[rowIndex] = 0
    this.size += 1
    this.idToRow.set(row.id, rowIndex)
    const rows = this.pathToRows.get(row.path)
    if (rows) rows.push(rowIndex)
    else this.pathToRows.set(row.path, [rowIndex])
  }

  /** Tombstones the row for `id`, if present. Returns whether a row was removed. */
  tombstoneById(id: number): boolean {
    const rowIndex = this.idToRow.get(id)
    if (rowIndex === undefined) return false
    return this.tombstoneRow(rowIndex, id)
  }

  /** Tombstones every live row for `path`. Returns the removed ids. */
  tombstoneByPath(path: string): number[] {
    const rows = this.pathToRows.get(path)
    if (!rows) return []
    // Resolve to ids up front, then tombstone by id (not by the row indices
    // captured here): a compaction triggered partway through this loop
    // remaps every row index, so continuing to use the pre-captured indices
    // would tombstone the wrong (remapped) rows.
    const ids = rows.map((rowIndex) => this.ids[rowIndex])
    const removedIds: number[] = []
    for (const id of ids) {
      if (this.tombstoneById(id)) removedIds.push(id)
    }
    return removedIds
  }

  private tombstoneRow(rowIndex: number, id: number): boolean {
    if (this.tombstones[rowIndex] === 1) return false
    this.tombstones[rowIndex] = 1
    this.tombstoneCount += 1
    this.idToRow.delete(id)
    const path = this.paths[rowIndex]
    const rows = this.pathToRows.get(path)
    if (rows) {
      const at = rows.indexOf(rowIndex)
      if (at !== -1) rows.splice(at, 1)
      if (rows.length === 0) this.pathToRows.delete(path)
    }
    if (
      this.size > 0 &&
      this.tombstoneCount / this.size > COMPACT_TOMBSTONE_RATIO
    ) {
      this.compact()
    }
    return true
  }

  private ensureCapacity(extraRows: number): void {
    const needed = this.size + extraRows
    if (needed <= this.capacityRows) return
    let newCapacity =
      this.capacityRows === 0 ? INITIAL_CAPACITY_ROWS : this.capacityRows
    while (newCapacity < needed) newCapacity *= 2
    const newMatrix = new Int8Array(newCapacity * this.dimension)
    newMatrix.set(this.matrix)
    this.matrix = newMatrix
    const newScales = new Float32Array(newCapacity)
    newScales.set(this.scales)
    this.scales = newScales
    const newTombstones = new Uint8Array(newCapacity)
    newTombstones.set(this.tombstones)
    this.tombstones = newTombstones
    this.capacityRows = newCapacity
  }

  private compact(): void {
    const newSize = this.size - this.tombstoneCount
    const newCapacity = Math.max(newSize, 1)
    const newMatrix = new Int8Array(newCapacity * this.dimension)
    const newScales = new Float32Array(newCapacity)
    const newIds: number[] = []
    const newPaths: string[] = []
    const newMetadata: VectorMetaData[] = []
    this.idToRow.clear()
    this.pathToRows.clear()

    let writeIndex = 0
    for (let readIndex = 0; readIndex < this.size; readIndex++) {
      if (this.tombstones[readIndex] === 1) continue
      newMatrix.set(
        this.matrix.subarray(
          readIndex * this.dimension,
          (readIndex + 1) * this.dimension,
        ),
        writeIndex * this.dimension,
      )
      newScales[writeIndex] = this.scales[readIndex]
      const id = this.ids[readIndex]
      const path = this.paths[readIndex]
      newIds[writeIndex] = id
      newPaths[writeIndex] = path
      newMetadata[writeIndex] = this.metadataList[readIndex]
      this.idToRow.set(id, writeIndex)
      const rows = this.pathToRows.get(path)
      if (rows) rows.push(writeIndex)
      else this.pathToRows.set(path, [writeIndex])
      writeIndex += 1
    }

    this.matrix = newMatrix
    this.scales = newScales
    this.ids = newIds
    this.paths = newPaths
    this.metadataList = newMetadata
    this.tombstones = new Uint8Array(newCapacity)
    this.capacityRows = newCapacity
    this.size = newSize
    this.tombstoneCount = 0
  }
}
