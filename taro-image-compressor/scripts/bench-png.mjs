/**
 * 对比基准：模拟用户场景（JPEG 解码后的带噪声像素 + 平滑渐变像素），
 * 对比 squoosh_png 基础编码 vs oxipng 优化编码的输出体积。
 * 运行于 Node，mock WXWebAssembly 从 dist/wasm 加载 brotli wasm。
 */
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'

globalThis.WXWebAssembly = {
  async instantiate(path, imports) {
    const compressed = readFileSync(`dist${path}`)
    const bytes = zlib.brotliDecompressSync(compressed)
    const { instance, module } = await WebAssembly.instantiate(bytes, imports)
    return { instance, module }
  },
}

const pngMod = await import('../worker-src/vendor/squoosh_png.js')
const oxi = await import('../worker-src/vendor/squoosh_oxipng.js')

await pngMod.default('/wasm/squoosh_png_bg.wasm.br')
await oxi.default('/wasm/squoosh_oxipng_bg.wasm.br')

const W = 2000, H = 1500

// 场景 A：平滑渐变（类似截图/图形 PNG）
function smoothPixels() {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4
      d[p] = (x * 255) / W
      d[p + 1] = (y * 255) / H
      d[p + 2] = ((x + y) * 255) / (W + H)
      d[p + 3] = 255
    }
  return d
}

// 场景 B：渐变 + 高频噪声（模拟 JPEG 有损压缩解码后的像素）
function noisyPixels() {
  const d = smoothPixels()
  for (let i = 0; i < d.length; i += 4) {
    d[i] += (Math.random() * 18 - 9) | 0
    d[i + 1] += (Math.random() * 18 - 9) | 0
    d[i + 2] += (Math.random() * 18 - 9) | 0
  }
  return d
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB'

for (const [name, data] of [['平滑渐变', smoothPixels()], ['带噪声(模拟JPEG解码)', noisyPixels()]]) {
  const t1 = Date.now()
  const basic = await pngMod.encode(data, W, H)
  const t2 = Date.now()
  const opt = oxi.optimise_raw(data, W, H, 2, false, false)
  const t3 = Date.now()
  console.log(`\n[${name}] ${W}x${H}`)
  console.log(`  squoosh_png: ${kb(basic.length)}  (${t2 - t1}ms)`)
  console.log(`  oxipng lvl2: ${kb(opt.length)}  (${t3 - t2}ms)`)
  console.log(`  减小: ${(((basic.length - opt.length) / basic.length) * 100).toFixed(1)}%`)
}
