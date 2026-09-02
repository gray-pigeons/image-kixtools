/**
 * 扫描 WASM 二进制的 code section，统计 SIMD（0xFD 前缀）与
 * atomics（0xFE 前缀）指令出现密度，判断模块是否依赖这些特性。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)

function readLeb(bytes, pos) {
  let result = 0
  let shift = 0
  while (pos < bytes.length) {
    const b = bytes[pos]
    pos += 1
    result |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
  }
  return [result >>> 0, pos]
}

function analyze(label, file) {
  const raw = readFileSync(file)
  const bytes = raw  // 未压缩
  let pos = 8 // 跳过 magic + version
  let codeStart = -1
  let codeEnd = -1
  while (pos < bytes.length) {
    const id = bytes[pos]
    pos += 1
    const [size, p2] = readLeb(bytes, pos)
    pos = p2
    if (id === 10) {
      codeStart = pos
      codeEnd = pos + size
      break
    }
    pos += size
  }
  if (codeStart < 0) {
    console.log(`${label}: 未找到 code section`)
    return
  }
  const code = bytes.subarray(codeStart, codeEnd)
  let simd = 0
  let atomics = 0
  for (let i = 0; i < code.length - 1; i++) {
    if (code[i] === 0xfd && code[i + 1] !== undefined) {
      const [op] = readLeb(code, i + 1)
      if (op <= 0xff) simd += 1
    }
    if (code[i] === 0xfe) atomics += 1
  }
  console.log(
    `${label}: code ${code.length} B, SIMD(0xFD) ${simd}, atomics(0xFE) ${atomics}`
  )
}

const targets = [
  ['oxipng 2.3.0', require.resolve('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm')],
  ['squoosh_png(真机可用)', require.resolve('@jsquash/png/codec/squoosh_png_bg.wasm')],
  ['mozjpeg_dec(真机可用)', require.resolve('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm')],
  ['webp_dec(真机可用)', require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')],
]

for (const [label, file] of targets) analyze(label, file)

// 对照：旧版 oxipng 1.0.1（Squoosh 原版 wasm）
try {
  const old = 'node_modules/@jsquash/oxipng@1/node_modules/@jsquash/oxipng/codec/squoosh_oxipng_bg.wasm'
  analyze('oxipng 1.x(对照)', old)
} catch {
  console.log('\n(未安装 oxipng@1 对照版本)')
}
