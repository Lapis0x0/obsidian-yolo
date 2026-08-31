import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildBadge,
  buildDateWindows,
  extractCoreVersionMainJsCounts,
  formatCompactNumber,
  isMirroredAssetPath,
  selectWindowsToRefresh,
  sumCloudflareGroups,
  updateDownloadStats,
} from './download-stats.mjs'

test('recognizes only mirrored downloadable artifact paths', () => {
  assert.equal(isMirroredAssetPath('/core/1.6.2/main.js'), true)
  assert.equal(isMirroredAssetPath('/modules/learning/0.1.2/entry.js'), true)
  assert.equal(
    isMirroredAssetPath('/runtime-components/1.6.2/tokenizer/entry.js'),
    true,
  )
  assert.equal(isMirroredAssetPath('/feed-v1.json'), false)
  assert.equal(isMirroredAssetPath('/feed-v1.sig'), false)
})

test('builds UTC daily windows with partial boundary days', () => {
  assert.deepEqual(
    buildDateWindows('2026-07-25T05:38:22.000Z', '2026-07-27T03:00:00.000Z'),
    [
      {
        date: '2026-07-25',
        from: '2026-07-25T05:38:22.000Z',
        to: '2026-07-26T00:00:00.000Z',
        complete: true,
      },
      {
        date: '2026-07-26',
        from: '2026-07-26T00:00:00.000Z',
        to: '2026-07-27T00:00:00.000Z',
        complete: true,
      },
      {
        date: '2026-07-27',
        from: '2026-07-27T00:00:00.000Z',
        to: '2026-07-27T03:00:00.000Z',
        complete: false,
      },
    ],
  )
})

test('refreshes missing dates and the trailing analytics window', () => {
  const windows = buildDateWindows(
    '2026-07-25T05:38:22.000Z',
    '2026-07-29T03:00:00.000Z',
  )
  assert.deepEqual(
    selectWindowsToRefresh(windows, {
      '2026-07-25': 10,
      '2026-07-26': 20,
      '2026-07-27': 30,
    }).map((window) => window.date),
    ['2026-07-27', '2026-07-28', '2026-07-29'],
  )
})

test('sums successful mirrored asset requests only', () => {
  assert.equal(
    sumCloudflareGroups([
      {
        count: 12,
        dimensions: {
          clientRequestPath: '/core/1.6.2/main.js',
          edgeResponseStatus: 200,
        },
      },
      {
        count: 3,
        dimensions: {
          clientRequestPath: '/modules/learning/0.1.2/entry.js',
          edgeResponseStatus: 206,
        },
      },
      {
        count: 99,
        dimensions: {
          clientRequestPath: '/feed-v1.json',
          edgeResponseStatus: 200,
        },
      },
      {
        count: 4,
        dimensions: {
          clientRequestPath: '/core/1.6.2/main.js',
          edgeResponseStatus: 404,
        },
      },
    ]),
    15,
  )
})

test('extracts per-version core main.js counts from successful requests', () => {
  assert.deepEqual(
    extractCoreVersionMainJsCounts([
      {
        count: 12,
        dimensions: {
          clientRequestPath: '/core/1.6.5/main.js',
          edgeResponseStatus: 200,
        },
      },
      {
        count: 5,
        dimensions: {
          clientRequestPath: '/core/1.6.5/main.js',
          edgeResponseStatus: 206,
        },
      },
      {
        count: 7,
        dimensions: {
          clientRequestPath: '/core/1.6.4.5/main.js',
          edgeResponseStatus: 200,
        },
      },
      {
        count: 30,
        dimensions: {
          clientRequestPath: '/core/1.6.5/styles.css',
          edgeResponseStatus: 200,
        },
      },
      {
        count: 4,
        dimensions: {
          clientRequestPath: '/core/1.6.5/main.js',
          edgeResponseStatus: 404,
        },
      },
    ]),
    { '1.6.5': 17, '1.6.4.5': 7 },
  )
})

test('formats the Shields endpoint payload like the previous badge', () => {
  assert.equal(formatCompactNumber(999), '999')
  assert.equal(formatCompactNumber(1_234), '1.2k')
  assert.equal(formatCompactNumber(217_508), '218k')
  assert.deepEqual(buildBadge(217_508), {
    schemaVersion: 1,
    label: 'downloads',
    message: '218k',
    color: '0984e3',
  })
})

test('combines paginated GitHub assets with persisted Cloudflare days', async () => {
  const releases = Array.from({ length: 100 }, (_, index) => ({
    assets: [{ download_count: index === 0 ? 100 : 1 }],
  }))
  const analyticsWindows = []
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith('https://api.cloudflare.com/client/v4/zones?')) {
      return Response.json({ success: true, result: [{ id: 'zone-id' }] })
    }
    if (url === 'https://api.cloudflare.com/client/v4/graphql') {
      const request = JSON.parse(init.body)
      if (request.query.includes('FeedRequests')) {
        return Response.json({
          data: {
            viewer: {
              zones: [
                {
                  httpRequestsAdaptiveGroups: [
                    { count: 30, dimensions: { clientIP: '203.0.113.7' } },
                    { count: 6, dimensions: { clientIP: '203.0.113.7' } },
                    { count: 4, dimensions: { clientIP: '198.51.100.9' } },
                  ],
                },
              ],
            },
          },
        })
      }
      analyticsWindows.push(request.variables)
      return Response.json({
        data: {
          viewer: {
            zones: [
              {
                httpRequestsAdaptiveGroups: [
                  {
                    count: 10,
                    dimensions: {
                      clientRequestPath: '/core/1.6.2/main.js',
                      edgeResponseStatus: 200,
                    },
                  },
                  {
                    count: 50,
                    dimensions: {
                      clientRequestPath: '/feed-v1.json',
                      edgeResponseStatus: 200,
                    },
                  },
                ],
              },
            ],
          },
        },
      })
    }
    if (url.includes('api.github.com')) {
      const page = new URL(url).searchParams.get('page')
      return Response.json(
        page === '1' ? releases : [{ assets: [{ download_count: 5 }] }],
      )
    }
    return new Response('unexpected request', { status: 404 })
  }

  const result = await updateDownloadStats({
    now: '2026-07-29T03:00:00.000Z',
    cloudflareToken: 'token',
    cloudflareAccountId: 'account-id',
    githubToken: 'github-token',
    fetchImpl,
    state: {
      schemaVersion: 1,
      cloudflareDaily: {
        '2026-07-25': 7,
        '2026-07-26': 8,
        '2026-07-27': 9,
      },
    },
  })

  assert.equal(analyticsWindows.length, 3)
  assert.deepEqual(
    analyticsWindows.map((window) => window.from.slice(0, 10)),
    ['2026-07-27', '2026-07-28', '2026-07-29'],
  )
  assert.equal(result.state.githubTotal, 204)
  assert.equal(result.state.cloudflareTotal, 45)
  assert.equal(result.state.total, 249)
  assert.equal(result.badge.message, '249')
  assert.deepEqual(result.state.coreVersionDaily, {
    '2026-07-27': { '1.6.2': 10 },
    '2026-07-28': { '1.6.2': 10 },
    '2026-07-29': { '1.6.2': 10 },
  })
  assert.deepEqual(result.state.feedDaily, {
    '2026-07-27': { requests: 40, uniques: 2 },
    '2026-07-28': { requests: 40, uniques: 2 },
    '2026-07-29': { requests: 40, uniques: 2 },
  })
})
