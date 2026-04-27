# `src/styles/` 组织约定

## 1. 按职责分目录，不按"哪里先用"

历史上 `panels/smart-space.css` 长期堆放了和 SmartSpace 面板无关的 popover、
dropdown、滚动条共享样式（因为 SmartSpace 是这些样式最早的消费者），
是典型的"以首个调用者命名"反模式，导致后续所有人都要绕开或踩坑。

**新增样式时的判断顺序：**
1. 它属于某个跨组件的**视觉系统**（popover、按钮、表单等）→ 找/建独立目录
   （现有：`popover/`）。
2. 它属于某个**功能模块**（chat、settings、panels 下的具体面板）→ 放进对应子目录。
3. **不要**因为「我现在的功能是 SmartSpace」就把通用样式塞进 `smart-space.css`。

## 2. 命名前缀

- 新增 CSS class → 一律 `yolo-` 前缀。
- 存量 `smtcmp-*` → 不做大规模重命名（外部主题 / CSS snippet 可能 target）。
- 旧组件被新抽象**完全替代**时，顺手删掉相关 `smtcmp-*` 死代码（删除而非改名）。

## 3. Popover / Dropdown 专项约定

详见 [`popover/surface.css`](./popover/surface.css) 文件头注释 ——
包含视觉/尺寸分离、变体文件归属、新增弹窗 checklist 等。
改弹窗或新增弹窗前请先读那段注释。

## 4. 编译

`styles.css` 是 PostCSS 从 `index.css` 编译产物，**不要直接编辑**。
改完源文件运行 `npm run styles:build`（或 `npm run styles:watch`）。
