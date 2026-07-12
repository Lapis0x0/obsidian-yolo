const readVarint = (bytes: Uint8Array, offset: number): [number, number] => {
  let value = 0
  let shift = 0
  while (offset < bytes.length && shift <= 49) {
    const byte = bytes[offset++]
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return [value, offset]
    shift += 7
  }
  throw new Error('Invalid protobuf varint')
}

export type ProtoField = {
  number: number
  wire: number
  value: number | Uint8Array
}

export const decodeProto = (bytes: Uint8Array): ProtoField[] => {
  const fields: ProtoField[] = []
  let offset = 0
  while (offset < bytes.length) {
    let tag
    ;[tag, offset] = readVarint(bytes, offset)
    const number = Math.floor(tag / 8)
    const wire = tag & 7
    if (!number) throw new Error('Invalid protobuf field')
    if (wire === 0) {
      let value
      ;[value, offset] = readVarint(bytes, offset)
      fields.push({ number, wire, value })
    } else if (wire === 2) {
      let length
      ;[length, offset] = readVarint(bytes, offset)
      if (length < 0 || offset + length > bytes.length)
        throw new Error('Truncated protobuf field')
      fields.push({
        number,
        wire,
        value: bytes.subarray(offset, offset + length),
      })
      offset += length
    } else if (wire === 1) offset += 8
    else if (wire === 5) offset += 4
    else throw new Error(`Unsupported protobuf wire type ${wire}`)
    if (offset > bytes.length) throw new Error('Truncated protobuf field')
  }
  return fields
}

const text = (value: number | Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: true }).decode(value as Uint8Array)

export const decodeModernMediaMap = (
  bytes: Uint8Array,
): Record<string, string> => {
  const result: Record<string, string> = {}
  let index = 0
  for (const field of decodeProto(bytes)) {
    if (field.wire !== 2) continue
    const entry = decodeProto(field.value as Uint8Array)
    const nameField = entry.find((item) => item.number === 1 && item.wire === 2)
    if (!nameField) continue
    const name = text(nameField.value)
    result[String(index++)] = name
  }
  return result
}

export const decodePackageVersion = (bytes: Uint8Array): number | null => {
  const field = decodeProto(bytes).find(
    (item) => item.number === 1 && item.wire === 0,
  )
  return typeof field?.value === 'number' ? field.value : null
}
