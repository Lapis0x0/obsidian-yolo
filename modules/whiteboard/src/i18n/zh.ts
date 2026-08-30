export const zh = {
  module: {
    name: 'YOLO 白板',
    open: '打开白板',
  },
  command: {
    newWhiteboard: '新建白板',
  },
  menu: {
    newWhiteboard: '新建 YOLO 白板',
    newCard: '新建卡片',
    convertToNote: '转为笔记',
    deleteCard: '删除',
  },
  file: {
    newWhiteboardBaseName: '白板',
    newNoteBaseName: '未命名',
  },
  notice: {
    convertedToNote: '卡片已保存为 {path}',
    dropUnsupported: '白板目前只能接收 Markdown 笔记。',
  },
  card: {
    missingFile: '文件丢失',
    missingFileHint: '此卡片引用的「{path}」已不存在。',
    pdfPlaceholder: 'PDF 卡片',
    pdfPlaceholderHint: 'PDF 卡片将在后续版本中支持。',
  },
  error: {
    title: '无法读取此白板',
    hint: '文件解析失败，内容未被修改——请在白板外修复后重新打开。',
    createFailed: '新建白板失败。',
    convertFailed: '无法把这张卡片转为笔记。',
    dropFailed: '无法把拖入的文件加到白板上。',
  },
}
