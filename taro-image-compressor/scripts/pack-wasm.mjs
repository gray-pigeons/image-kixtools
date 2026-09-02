/**
 * 将 @jsquash 编解码器的 .wasm 二进制做 brotli 压缩，输出到 wasm/ 目录。
 *
 * 微信小程序的 WXWebAssembly.instantiate 支持加载代码包内 .wasm.br 文件
 * （基础库 v2.14.0+），brotli 压缩可显著降低包体积以适配主包 2MB 限制。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)

const TARGETS = [
  ['@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm', 'mozjpeg_dec'],
  ['@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm', 'mozjpeg_enc'],
  ['@jsquash/webp/codec/dec/webp_dec.wasm', 'webp_dec'],
  ['@jsquash/webp/codec/enc/webp_enc.wasm', 'webp_enc'],
  ['@jsquash/png/codec/squoosh_png_bg.wasm', 'squoosh_png_bg'],
  ['@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm', 'squoosh_oxipng_bg'],
]

mkdirSync('wasm', { recursive: true })

let totalBefore = 0
let totalAfter = 0

for (const [spec, name] of TARGETS) {
  const src = require.resolve(spec)
  const raw = readFileSync(src)
  const packed = zlib.brotliCompressSync(raw, {
    params: [zlib.constants.BROTLI_PARAM_QUALITY, 11],
  })
  writeFileSync(`wasm/${name}.wasm.br`, packed)
  totalBefore += raw.length
  totalAfter += packed.length
  console.log(
    `[pack-wasm] ${name}.wasm.br: ${(raw.length / 1024).toFixed(0)} KB -> ${(packed.length / 1024).toFixed(0)} KB`
  )
}

console.log(
  `[pack-wasm] 合计: ${(totalBefore / 1024).toFixed(0)} KB -> ${(totalAfter / 1024).toFixed(0)} KB（压缩至 ${Math.round((totalAfter / totalBefore) * 100)}%）`
)
