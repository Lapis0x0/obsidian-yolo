import { spawn } from 'child_process'
import fs from 'fs/promises'
import path from 'path'

const shardSizes = (process.env.YOLO_SWEEP_MAX_VECTORS_PER_SHARD ?? '2000,1000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)

const blockSizes = (process.env.YOLO_SWEEP_VECTOR_BLOCK_SIZE ?? '256,128,64,32')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)

const baseEnv = {
  ...process.env,
  YOLO_RUN_REAL_VAULT_BENCHMARK: '1',
  YOLO_BENCHMARK_MAX_ROWS: process.env.YOLO_BENCHMARK_MAX_ROWS ?? '5000',
  YOLO_BENCHMARK_QUERY_COUNT: process.env.YOLO_BENCHMARK_QUERY_COUNT ?? '12',
  YOLO_BENCHMARK_MEMORY_SAMPLE_MS:
    process.env.YOLO_BENCHMARK_MEMORY_SAMPLE_MS ?? '25',
  YOLO_BENCHMARK_QUERY_MODE: process.env.YOLO_BENCHMARK_QUERY_MODE ?? 'auto',
  NODE_OPTIONS:
    process.env.NODE_OPTIONS ?? '--experimental-vm-modules',
}

const sweepOutputDir = path.resolve('tmp/benchmark-sweep')

const runOne = (maxVectorsPerShard, vectorBlockSize) =>
  new Promise(async (resolve, reject) => {
    const outputPath = path.join(
      sweepOutputDir,
      `real-vault-${maxVectorsPerShard}-${vectorBlockSize}.json`,
    )
    await fs.mkdir(sweepOutputDir, { recursive: true })
    const child =
      process.platform === 'win32'
        ? spawn(
            'cmd.exe',
            [
              '/d',
              '/s',
              '/c',
              'npx jest src/database/modules/vector/backend/sharded/realVaultBenchmark.test.ts --runInBand',
            ],
            {
              env: {
                ...baseEnv,
                YOLO_BENCHMARK_MAX_VECTORS_PER_SHARD: String(maxVectorsPerShard),
                YOLO_BENCHMARK_VECTOR_BLOCK_SIZE: String(vectorBlockSize),
                YOLO_BENCHMARK_OUTPUT_PATH: outputPath,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
        : spawn(
            'npx',
            [
              'jest',
              'src/database/modules/vector/backend/sharded/realVaultBenchmark.test.ts',
              '--runInBand',
            ],
            {
              env: {
                ...baseEnv,
                YOLO_BENCHMARK_MAX_VECTORS_PER_SHARD: String(maxVectorsPerShard),
                YOLO_BENCHMARK_VECTOR_BLOCK_SIZE: String(vectorBlockSize),
                YOLO_BENCHMARK_OUTPUT_PATH: outputPath,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `benchmark failed for maxVectorsPerShard=${maxVectorsPerShard}, vectorBlockSize=${vectorBlockSize}\n${stderr}`,
          ),
        )
        return
      }
      fs.readFile(outputPath, 'utf8')
        .then((raw) => JSON.parse(raw)?.aggregate ?? null)
        .then((aggregate) => {
          if (!aggregate) {
            reject(
              new Error(
                `failed to parse aggregate for maxVectorsPerShard=${maxVectorsPerShard}, vectorBlockSize=${vectorBlockSize}`,
              ),
            )
            return
          }
          resolve(aggregate)
        })
        .catch(() => {
          reject(
            new Error(
              `failed to parse aggregate for maxVectorsPerShard=${maxVectorsPerShard}, vectorBlockSize=${vectorBlockSize}`,
            ),
          )
        })
    })
  })

const main = async () => {
  const results = []
  for (const maxVectorsPerShard of shardSizes) {
    for (const vectorBlockSize of blockSizes) {
      console.log(
        `\n[YOLO][Sweep] running maxVectorsPerShard=${maxVectorsPerShard}, vectorBlockSize=${vectorBlockSize}\n`,
      )
      const aggregate = await runOne(maxVectorsPerShard, vectorBlockSize)
      results.push({
        maxVectorsPerShard,
        vectorBlockSize,
        avgShardedColdMs: aggregate.avgShardedColdMs,
        avgShardedWarmMs: aggregate.avgShardedWarmMs,
        avgShardedColdVectorBlockLoadMs:
          aggregate.avgShardedColdVectorBlockLoadMs,
        avgShardedWarmVectorBlockLoadMs:
          aggregate.avgShardedWarmVectorBlockLoadMs,
        avgShardedOverlapVsExactAtK: aggregate.avgShardedOverlapVsExactAtK,
        shardedFullPathOrderMatchVsExactRate:
          aggregate.shardedFullPathOrderMatchVsExactRate,
        buildDurationMs: aggregate.buildDurationMs,
        shardedIncrementalUpdateDurationMs:
          aggregate.shardedIncrementalUpdateDurationMs,
        shardedIncrementalDeleteDurationMs:
          aggregate.shardedIncrementalDeleteDurationMs,
      })
    }
  }

  console.log('\n[YOLO][Sweep][Summary]')
  console.table(results)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
