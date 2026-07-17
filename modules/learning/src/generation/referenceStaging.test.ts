import type { LearningVaultWriteApi } from '../domain/learningVaultWriteApi'

import {
  cleanupStaging,
  createStagingDir,
  moveStagingToProject,
  writeReferenceToStaging,
} from './referenceStaging'

function createWriter() {
  const writer = {
    ensureFolder: jest.fn(async () => undefined),
    listChildFilePaths: jest.fn(async () => [
      'Learning/_staging/temp/notes.md',
      'Learning/_staging/temp/paper.pdf',
    ]),
    createBinary: jest.fn(async () => undefined),
    renamePath: jest.fn(async () => undefined),
    removeTree: jest.fn(async () => undefined),
  }
  return writer as typeof writer & LearningVaultWriteApi
}

describe('Learning reference staging boundary', () => {
  it('creates normalized staging paths and writes binary references', async () => {
    const writer = createWriter()
    const stagingDir = await createStagingDir(writer, '/Learning//', 'temp')
    const content = new ArrayBuffer(3)

    const reference = await writeReferenceToStaging(
      writer,
      stagingDir,
      'notes.md',
      content,
    )

    expect(stagingDir).toBe('Learning/_staging/temp')
    expect(writer.ensureFolder).toHaveBeenCalledWith(stagingDir)
    expect(writer.createBinary).toHaveBeenCalledWith(
      'Learning/_staging/temp/notes.md',
      content,
    )
    expect(reference).toEqual({
      name: 'notes.md',
      vaultPath: 'Learning/_staging/temp/notes.md',
    })
  })

  it('moves each staged file, then removes the staging tree', async () => {
    const writer = createWriter()

    await expect(
      moveStagingToProject(writer, 'Learning/_staging/temp', 'Learning/React'),
    ).resolves.toBe('Learning/React/ref')

    expect(writer.ensureFolder).toHaveBeenCalledWith('Learning/React/ref')
    expect(writer.renamePath.mock.calls).toEqual([
      ['Learning/_staging/temp/notes.md', 'Learning/React/ref/notes.md'],
      ['Learning/_staging/temp/paper.pdf', 'Learning/React/ref/paper.pdf'],
    ])
    expect(writer.removeTree).toHaveBeenCalledWith('Learning/_staging/temp')
  })

  it('treats cleanup of an absent staging tree as complete', async () => {
    const writer = createWriter()
    writer.removeTree = jest.fn(async () => {
      throw new Error('missing')
    })

    await expect(
      cleanupStaging(writer, 'Learning/_staging/missing'),
    ).resolves.toBeUndefined()
  })
})
