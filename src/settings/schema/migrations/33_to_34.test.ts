import { migrateFrom33To34 } from './33_to_34'

describe('migrateFrom33To34', () => {
  it('adds yolo.baseDir default when missing', () => {
    const result = migrateFrom33To34({
      version: 33,
    })

    expect(result.version).toBe(34)
    expect(result.yolo).toEqual({ baseDir: 'YOLO' })
  })

  it('keeps existing yolo.baseDir value', () => {
    const result = migrateFrom33To34({
      version: 33,
      yolo: {
        baseDir: 'Config/YOLO',
      },
    })

    expect(result.version).toBe(34)
    expect(result.yolo).toEqual({ baseDir: 'Config/YOLO' })
  })
})
