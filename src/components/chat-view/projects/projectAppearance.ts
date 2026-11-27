/** 项目图标可选的 lucide 图标名，第一个是新建时的默认值。 */
export const PROJECT_ICONS = [
  'folder',
  'book-open',
  'graduation-cap',
  'layers',
  'file-text',
  'flask-conical',
  'briefcase',
  'message-square',
  'lightbulb',
  'pen-tool',
] as const

/**
 * 项目颜色。项目里存的是颜色名，这里决定它画成什么颜色，以后调色不用动用户
 * 的数据。
 *
 * 在 OKLCH 里取同样的亮度（约 0.72）和饱和度（约 0.13），只换色相，并排放着
 * 没有哪个特别跳。0.62 一档做成实心色块偏沉、偏灰；再往上淡底上的图标就发虚。
 * 琥珀单独提亮到 0.80，否则会发褐。
 * 第一个是新建项目时的默认值。
 */
export const PROJECT_COLORS = {
  blue: '#60aaf3',
  violet: '#ab93ed',
  teal: '#36baba',
  green: '#62bb78',
  amber: '#e9b452',
  terracotta: '#e98664',
  rose: '#e680a1',
  slate: '#979fab',
} as const

export type ProjectColorId = keyof typeof PROJECT_COLORS

export const PROJECT_COLOR_IDS = Object.keys(PROJECT_COLORS) as ProjectColorId[]

const DEFAULT_PROJECT_COLOR: ProjectColorId = 'blue'

/** 项目存的颜色名；没有或不认识时用默认色 */
export const getProjectColorId = (color: string | undefined): ProjectColorId =>
  color !== undefined && color in PROJECT_COLORS
    ? (color as ProjectColorId)
    : DEFAULT_PROJECT_COLOR

/** 给项目相关的元素提供 --yolo-project-color，样式里据此混出底色 */
export const projectColorStyle = (color: string | undefined) =>
  ({
    '--yolo-project-color': PROJECT_COLORS[getProjectColorId(color)],
  }) as React.CSSProperties
