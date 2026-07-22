import { LearningProjectService } from './projectService'

describe('LearningProjectService', () => {
  it('resolves the current learning base directory for every scan', async () => {
    let baseDir = 'Old/learning'
    const scanner = {
      scanProjects: jest.fn(async () => ({ projects: [] })),
    }
    const service = new LearningProjectService({
      getLearningBaseDir: () => baseDir,
      scanner,
    })

    await service.scanProjects()
    baseDir = 'New/learning'
    await service.scanProjects()

    expect(scanner.scanProjects.mock.calls).toEqual([
      ['Old/learning'],
      ['New/learning'],
    ])
    expect(service.getLearningBaseDir()).toBe('New/learning')
  })
})
