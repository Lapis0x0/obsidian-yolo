import type { SettingMigration } from '../setting.types'

export const migrateFrom33To34: SettingMigration['migrate'] = (data) => {
  const newData = { ...data }
  newData.version = 34

  const yoloRecord =
    newData.yolo && typeof newData.yolo === 'object'
      ? (newData.yolo as Record<string, unknown>)
      : {}

  newData.yolo = {
    ...yoloRecord,
    baseDir:
      typeof yoloRecord.baseDir === 'string' && yoloRecord.baseDir.trim().length
        ? yoloRecord.baseDir
        : 'YOLO',
  }

  return newData
}
