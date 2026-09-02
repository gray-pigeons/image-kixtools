/**
 * 用 wabt 将 WASM 反汇编为 wat 文本，精确检测 SIMD(v128) / atomics 指令。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const wabt = await import('wabt').then((m) => m.default || m)

function analyze(label, file) {
  const raw = readFileSync(file)
  const mod = wabt.readWasm(new Uint8Array(raw), { readDebugNames: false })
  const { toText } = mod.toText({}) // 返回 { toText }，实际 API 见 wabt 文档
  const text = typeof toText === 'string' ? toText : mod.toText({ foldExprs: false, inlineExport: false })
  const v128 = (text.match(/v128/g) || []).length
  const atomic = (text.match(/\.atomic\./g) || []).length
  const sharedMem = /memory\s+\(.*shared/.test(text)
  console.log(`${label}: v128=${v128}, atomic=${atomic}, sharedMemory=${sharedMem}`)
}

for (const [label, spec] of [
  ['oxipng 2.3.0     ', '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm'],
  ['squoosh_png(真机OK)', '@jsquash/png/codec/squoosh_png_bg.wasm'],
  ['mozjpeg_dec(真机OK)', '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'],
  ['webp_dec(真机OK)  ', '@jsquash/webp/codec/dec/webp_dec.wasm'],
]) {
  try {
    analyze(label, require.resolve(spec))
  } catch (e) {
    console.log(`${label}: 解析失败 ${e.message}`)
  }
}
