/**
 * 用 @webassemblyjs/wasm-parser 解析 WASM AST，精确统计
 * SIMD / atomics 指令与 shared memory，判断真机兼容性风险。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { decode } = await import('@webassemblyjs/wasm-parser')

function countInstr(ast) {
  const counts = { simd: 0, atomic: 0, sharedMem: 0 }
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (node.id === 'memory' && node.type === 'Memory' && node.initMax != null) {
      // shared memory 通过 MemoryType 标记
    }
    if (typeof node.id === 'string') {
      if (node.id.startsWith('v128')) counts.simd += 1
      if (node.id.includes('atomic')) counts.atomic += 1
    }
    if (node.type === 'MemoryType' && node.shared) counts.sharedMem += 1
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'range') continue
      visit(node[k])
    }
  }
  visit(ast)
  return counts
}

for (const [label, spec] of [
  ['oxipng 2.3.0       ', '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm'],
  ['squoosh_png(真机OK)', '@jsquash/png/codec/squoosh_png_bg.wasm'],
  ['mozjpeg_dec(真机OK)', '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'],
  ['webp_dec(真机OK)   ', '@jsquash/webp/codec/dec/webp_dec.wasm'],
]) {
  try {
    const raw = readFileSync(require.resolve(spec))
    const ast = decode(raw, { dump: false, ignoreCodeSection: false })
    const c = countInstr(ast)
    console.log(`${label}: SIMD=${c.simd}, atomic=${c.atomic}, sharedMem=${c.sharedMem}`)
  } catch (e) {
    console.log(`${label}: 解析失败 ${e.message.split('\n')[0]}`)
  }
}
