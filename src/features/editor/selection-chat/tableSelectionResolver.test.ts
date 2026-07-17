import {
  resolveMarkdownTableSelectionFromCoordinates,
  resolveMarkdownTableSelectionFromTableElement,
} from './tableSelectionResolver'

describe('tableSelectionResolver', () => {
  const source = [
    '# 问题排查记录',
    '',
    '| 序号 | 测试日期 | 功能模块 | 测试场景 | 操作步骤 | 预期结果 | 实际结果 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | 2026-07-07 | 文件系统 | 创建文件 | 调用 fs_write 新建 .md 文件 | 文件创建成功 | 文件创建成功 |',
    '| 2 | 2026-07-07 | 文件系统 | 读取文件 | 调用 fs_read 读取已有文件 | 返回文件内容 | 返回文件内容 |',
    '| 3 | 2026-07-07 | 文件系统 | 编辑文件 | 调用 fs_edit 修改指定行 | 指定内容被替换 | 指定内容被替换 |',
    '| 4 | 2026-07-07 | 文件系统 | 删除文件 | 调用 fs_delete 删除文件 | 文件移至回收站 | 文件移至回收站 |',
    '| 5 | 2026-07-07 | 文件系统 | 移动文件 | 调用 fs_move 重命名 | 文件名变更 | 文件名变更 |',
  ].join('\n')

  test('serializes selected body cells as a markdown subtable with headers', () => {
    const result = resolveMarkdownTableSelectionFromCoordinates(source, 7, {
      startRow: 3,
      endRow: 5,
      startColumn: 2,
      endColumn: 4,
    })

    expect(result).toEqual({
      content: [
        '| 序号 | ... | 功能模块 | 测试场景 | 操作步骤 | ... |',
        '| --- | --- | --- | --- | --- | --- |',
        '| 3 | ... | 文件系统 | 编辑文件 | 调用 fs_edit 修改指定行 | ... |',
        '| 4 | ... | 文件系统 | 删除文件 | 调用 fs_delete 删除文件 | ... |',
        '| 5 | ... | 文件系统 | 移动文件 | 调用 fs_move 重命名 | ... |',
      ].join('\n'),
      startLine: 7,
      endLine: 9,
      rowCount: 3,
      columnCount: 3,
    })
  })

  test('clamps selected coordinates to the parsed table size', () => {
    const result = resolveMarkdownTableSelectionFromCoordinates(source, 5, {
      startRow: 1,
      endRow: 20,
      startColumn: 5,
      endColumn: 20,
    })

    expect(result?.content).toBe(
      [
        '| 序号 | ... | 预期结果 | 实际结果 |',
        '| --- | --- | --- | --- |',
        '| 1 | ... | 文件创建成功 | 文件创建成功 |',
        '| 2 | ... | 返回文件内容 | 返回文件内容 |',
        '| 3 | ... | 指定内容被替换 | 指定内容被替换 |',
        '| 4 | ... | 文件移至回收站 | 文件移至回收站 |',
        '| 5 | ... | 文件名变更 | 文件名变更 |',
      ].join('\n'),
    )
  })

  test('returns null when source line is not inside a markdown table', () => {
    expect(
      resolveMarkdownTableSelectionFromCoordinates(source, 1, {
        startRow: 1,
        endRow: 1,
        startColumn: 0,
        endColumn: 0,
      }),
    ).toBeNull()
  })

  test('resolves table element selection by source line instead of table index', () => {
    const sourceWithTwoTables = [
      '| A | B |',
      '| --- | --- |',
      '| wrong | table |',
      '',
      '| 项目 | 测试内容 | 测试数据 | 预期结果 |',
      '| --- | --- | --- | --- |',
      '| 1 | 登录功能 | 用户名/密码 | 登录成功 |',
      '| 2 | 注册功能 | 邮箱/验证码 | 注册成功 |',
      '| 3 | 搜索功能 | 关键词 | 返回结果列表 |',
    ].join('\n')
    const table = createSelectedTableElement([
      [1, 2],
      [1, 3],
      [2, 2],
      [2, 3],
    ])

    const result = resolveMarkdownTableSelectionFromTableElement(
      sourceWithTwoTables,
      5,
      table,
    )

    expect(result).toEqual({
      content: [
        '| 项目 | ... | 测试数据 | 预期结果 |',
        '| --- | --- | --- | --- |',
        '| 1 | ... | 用户名/密码 | 登录成功 |',
        '| 2 | ... | 邮箱/验证码 | 注册成功 |',
      ].join('\n'),
      startLine: 7,
      endLine: 8,
      rowCount: 2,
      columnCount: 2,
    })
  })
})

function createSelectedTableElement(cells: Array<[number, number]>): Element {
  const selectedCells = cells.map(([rowIndex, cellIndex]) => ({
    tagName: 'TD',
    cellIndex,
    parentElement: {
      closest: (selector: string) =>
        selector === 'tr'
          ? {
              rowIndex,
            }
          : null,
    },
  }))

  return {
    querySelectorAll: (selector: string) =>
      selector === 'td.is-selected, th.is-selected' ? selectedCells : [],
  } as unknown as Element
}
