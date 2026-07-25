// eslint-disable-next-line import/no-nodejs-modules -- validates committed release metadata in Node-based CI
import { readFileSync } from 'node:fs'

import { parseOfficialModuleCatalog } from '../modules/officialModuleCatalog'

import {
  projectDistributionFeedCatalog,
  verifyAndParseDistributionFeed,
} from './distributionFeed'

describe('generated distribution metadata', () => {
  it('is signed by the client trust root and matches the old-client projection', () => {
    const feed = verifyAndParseDistributionFeed(
      readFileSync('distribution/feed-v1.json'),
      readFileSync('distribution/feed-v1.sig', 'utf8').trim(),
    )
    const projected = projectDistributionFeedCatalog(feed)
    const committedCatalog = parseOfficialModuleCatalog(
      readFileSync('modules/catalog-v1.json'),
      {
        allowedRepositories: [{ owner: 'Lapis0x0', repo: 'obsidian-yolo' }],
      },
    )

    expect(committedCatalog).toEqual(projected)
  })
})
