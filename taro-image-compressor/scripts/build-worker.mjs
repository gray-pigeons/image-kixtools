/**
 * 将 worker-src 打包为微信小程序可用的 Worker（CommonJS、单文件）。
 *
 * Worker 线程只支持 CommonJS require，且目录内只打包 .js 文件，
 * 因此用 esbuild 把 TS 源码与 @jsquash 编解码器胶水内联成一个 workers/index.js，
 * WASM 二进制由 pack-wasm.mjs 单独处理并放在 worker 目录外。
 */
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

mkdirSync('workers', { recursive: true })

const result = await build({
  entryPoints: ['worker-src/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'neutral',
  target: 'es2018',
  outfile: 'workers/index.js',
  minify: true,
  legalComments: 'inline',
  logLevel: 'info',
  metafile: true,
})

console.log('[build-worker] workers/index.js 已生成')

if (result?.metafile) {
  for (const [out, entry] of Object.entries(result.metafile.outputs)) {
    console.log(`[build-worker] ${out}: ${(entry.bytes / 1024).toFixed(1)} KB`)
  }
}
