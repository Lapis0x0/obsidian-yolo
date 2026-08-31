export const zh = {
  module: {
    name: 'YOLO 白板',
    open: '打开白板',
  },
  command: {
    newWhiteboard: '新建白板',
    importAllCanvas: '把全部 Canvas 导入为 YOLO 白板',
  },
  menu: {
    newWhiteboard: '新建 YOLO 白板',
    importCanvas: '导入为 YOLO 白板',
    newCard: '新建卡片',
    convertToNote: '转为笔记',
    deleteCard: '删除',
  },
  file: {
    newWhiteboardBaseName: '白板',
    newNoteBaseName: '未命名',
  },
  confirm: {
    importAllTitle: '导入 Canvas 文件',
    importAllMessage:
      '将为库中 {count} 个 Canvas 文件各生成一个同名 YOLO 白板，放在原文件旁边。Canvas 原文件不会被改动。',
    importAllCta: '导入',
  },
  notice: {
    convertedToNote: '卡片已保存为 {path}',
    dropUnsupported: '白板目前只能接收笔记、图片、音频和视频。',
    imported: '已导入为 {path}',
    importedAll: '已导入 {imported} 个 Canvas 文件，{failed} 个无法读取。',
    importNoneFound: '库中没有找到 Canvas 文件。',
  },
  card: {
    missingFile: '文件丢失',
    missingFileHint: '此卡片引用的「{path}」已不存在。',
    unsupportedFile: '暂不支持预览',
    unsupportedFileHint: '「{path}」还没有对应的卡片形态。',
    linkNotWeb: '不是网页地址',
    linkNotWebHint: '只能显示 http 和 https 网页，此卡片指向「{url}」。',
  },
  error: {
    title: '无法读取此白板',
    hint: '文件解析失败，内容未被修改——请在白板外修复后重新打开。',
    createFailed: '新建白板失败。',
    convertFailed: '无法把这张卡片转为笔记。',
    dropFailed: '无法把拖入的文件加到白板上。',
    importFailed: '无法导入这个 Canvas 文件。',
  },
}
