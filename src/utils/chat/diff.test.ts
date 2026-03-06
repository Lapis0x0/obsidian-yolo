import { createDiffBlocks } from './diff'

describe('createDiffBlocks', () => {
  it('keeps normal paragraph edits as inline diffs', () => {
    const blocks = createDiffBlocks('Alpha beta gamma', 'Alpha beta delta')

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'modified',
      presentation: 'inline',
      blockType: 'paragraph',
      originalValue: 'Alpha beta gamma',
      modifiedValue: 'Alpha beta delta',
    })
  })

  it('renders markdown tables as a block diff', () => {
    const blocks = createDiffBlocks(
      ['| Name | Score |', '| --- | --- |', '| Alice | 1 |'].join('\n'),
      ['| Name | Score |', '| --- | --- |', '| Alice | 2 |'].join('\n'),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'modified',
      presentation: 'block',
      blockType: 'table',
      originalValue: [
        '| Name | Score |',
        '| --- | --- |',
        '| Alice | 1 |',
      ].join('\n'),
      modifiedValue: [
        '| Name | Score |',
        '| --- | --- |',
        '| Alice | 2 |',
      ].join('\n'),
    })
  })

  it('renders fenced code blocks as a block diff', () => {
    const blocks = createDiffBlocks(
      ['```ts', 'const value = 1', '```'].join('\n'),
      ['```ts', 'const value = 2', '```'].join('\n'),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'modified',
      presentation: 'block',
      blockType: 'codeFence',
      originalValue: ['```ts', 'const value = 1', '```'].join('\n'),
      modifiedValue: ['```ts', 'const value = 2', '```'].join('\n'),
    })
  })

  it('combines heading and following list into one section diff block', () => {
    const blocks = createDiffBlocks(
      ['## Goals', '1. Finalise sprint backlog'].join('\n'),
      [
        '## Goals',
        '1. 次のスプリントのためにスプリントバックログを確定する。',
      ].join('\n'),
    )

    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'modified',
      presentation: 'block',
      blockType: 'section',
      originalValue: ['## Goals', '1. Finalise sprint backlog'].join('\n'),
      modifiedValue: [
        '## Goals',
        '1. 次のスプリントのためにスプリントバックログを確定する。',
      ].join('\n'),
    })
  })

  it('keeps insertion separate from a nearby modification inside one hunk', () => {
    const blocks = createDiffBlocks(
      'Keep paragraph',
      ['Inserted paragraph', '', 'Keep paragraph updated'].join('\n'),
    )

    const contentBlocks = blocks.filter(
      (block) =>
        block.type !== 'modified' ||
        block.blockType !== 'blank' ||
        (block.modifiedValue ?? '').length > 0,
    )

    expect(contentBlocks).toHaveLength(2)
    expect(contentBlocks[0]).toMatchObject({
      type: 'modified',
      originalValue: undefined,
      modifiedValue: 'Inserted paragraph',
    })
    expect(contentBlocks[1]).toMatchObject({
      type: 'modified',
      originalValue: 'Keep paragraph',
      modifiedValue: 'Keep paragraph updated',
    })
  })

  it('preserves unchanged content around structured block diffs', () => {
    const blocks = createDiffBlocks(
      [
        'Intro',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        'Outro',
      ].join('\n'),
      [
        'Intro',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 3 |',
        '',
        'Outro',
      ].join('\n'),
    )

    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({ type: 'unchanged', value: 'Intro\n' })
    expect(blocks[1]).toMatchObject({
      type: 'modified',
      presentation: 'block',
      blockType: 'table',
    })
    expect(blocks[2]).toEqual({ type: 'unchanged', value: '\nOutro' })
  })
})
