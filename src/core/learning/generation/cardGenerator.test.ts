import {
  parseCardDrafts,
  parseWrittenCardEntries,
  validateWrittenCards,
} from './cardGenerator'

describe('cardGenerator validation', () => {
  it('parses the strict draft format', () => {
    expect(
      parseCardDrafts(`## 所有权 <!--kp:aaaaaaaa-->

**正面：** 什么是所有权？

**背面：** 值在任一时刻只有一个所有者。`),
    ).toEqual([
      {
        title: '所有权',
        kpUuid: 'aaaaaaaa',
        front: '什么是所有权？',
        back: '值在任一时刻只有一个所有者。',
        startLine: 1,
      },
    ])
  })

  it('keeps empty fields invalid instead of accepting placeholders', () => {
    const entries = parseWrittenCardEntries(`---
title: 测试
---

## <!--card:11111111 kp:aaaaaaaa-->

**正面：**

**背面：**`)
    const result = validateWrittenCards(
      entries,
      new Set(['11111111']),
      new Set(['aaaaaaaa']),
    )

    expect(result.valid).toHaveLength(0)
    expect(result.invalid[0]?.errors).toEqual([
      '缺少标题',
      '缺少精确格式的 **正面：** 内容',
      '缺少精确格式的 **背面：** 内容',
    ])
  })

  it('rejects duplicate, missing, and unexpected card UUIDs', () => {
    const entries =
      parseWrittenCardEntries(`## A <!--card:11111111 kp:aaaaaaaa-->

**正面：** A?

**背面：** A

## B <!--card:11111111 kp:aaaaaaaa-->

**正面：** B?

**背面：** B

## C <!--card:33333333 kp:aaaaaaaa-->

**正面：** C?

**背面：** C`)
    const result = validateWrittenCards(
      entries,
      new Set(['11111111', '22222222']),
      new Set(['aaaaaaaa']),
    )

    expect(result.valid).toHaveLength(0)
    expect(result.invalid).toEqual([
      expect.objectContaining({
        cardUuid: '11111111',
        errors: ['card UUID 重复'],
      }),
      expect.objectContaining({
        cardUuid: '22222222',
        errors: ['缺少该 card UUID'],
      }),
    ])
    expect(result.discardedCount).toBe(3)
  })
})
