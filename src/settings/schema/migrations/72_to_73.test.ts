import { migrateFrom72To73 } from './72_to_73'

describe('migrateFrom72To73', () => {
  it('defaults missing vector backend to sharded', () => {
    expect(
      migrateFrom72To73({
        version: 72,
        yolo: { baseDir: 'YOLO' },
      }),
    ).toMatchObject({
      version: 73,
      yolo: {
        baseDir: 'YOLO',
        vectorBackend: 'sharded',
      },
    })
  })

  it('preserves explicit vector backend choice', () => {
    expect(
      migrateFrom72To73({
        version: 72,
        yolo: { baseDir: 'YOLO', vectorBackend: 'pglite' },
      }),
    ).toMatchObject({
      version: 73,
      yolo: {
        baseDir: 'YOLO',
        vectorBackend: 'pglite',
      },
    })
  })
})
