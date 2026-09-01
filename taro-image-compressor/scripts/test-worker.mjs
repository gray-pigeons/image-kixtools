/**
 * Worker 压缩流水线端到端测试（Node 环境模拟小程序 Worker）。
 *
 * 通过 mock worker / WXWebAssembly 全局对象加载真实的 workers/index.js 产物
 * 与 brotli 压缩的 WASM 模块，验证：PNG 解码 -> JPEG/WebP/PNG 编码 -> 结果魔数
 * 以及 WebP 解码回环。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'

const require = createRequire(import.meta.url)

// ---- mock 小程序 Worker 环境 ----
const replies = []
let handler = null
globalThis.worker = {
  onMessage(cb) {
    handler = cb
  },
  postMessage(msg) {
    replies.push(msg)
  },
}

globalThis.WXWebAssembly = {
  async instantiate(path, imports) {
    // 与小程序一致：从代码包路径读取 brotli 压缩的 wasm 并实例化
    const compressed = readFileSync(`dist${path}`)
    const bytes = zlib.brotliDecompressSync(compressed)
    const { instance, module } = await WebAssembly.instantiate(bytes, imports)
    return { instance, module }
  },
}

require('../workers/index.js')

// ---- 生成一张测试 PNG（64x64 RGBA 渐变） ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function makeTestPng(width = 64, height = 64) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4)
    raw[row] = 0 // filter: none
    for (let x = 0; x < width; x += 1) {
      const p = row + 1 + x * 4
      raw[p] = (x * 255) / width
      raw[p + 1] = (y * 255) / height
      raw[p + 2] = 128
      raw[p + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ---- 测试驱动 ----
function compress(id, buffer, sourceType, outputType, quality) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`压缩超时: ${sourceType} -> ${outputType}`)),
      30000
    )
    const startLen = replies.length
    handler({ type: 'compress', id, buffer, sourceType, outputType, quality })
    const poll = setInterval(() => {
      const reply = replies.slice(startLen).find((r) => r.id === id)
      if (!reply) return
      clearInterval(poll)
      clearTimeout(timer)
      resolve(reply)
    }, 20)
  })
}

function assert(cond, message) {
  if (!cond) throw new Error(`断言失败: ${message}`)
  console.log(`  ✓ ${message}`)
}

const png = makeTestPng()

console.log('[test] PNG -> WebP (quality 75)')
const webp = await compress(1, png.buffer.slice(png.byteOffset, png.byteOffset + png.length), 'png', 'webp', 75)
assert(webp.type === 'done', '压缩成功返回 done')
assert(webp.size > 0, `输出非空（${webp.size} 字节）`)
{
  const head = new Uint8Array(webp.buffer, 0, 12)
  assert(
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
      head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50,
    '输出为合法 WebP（RIFF....WEBP 魔数）'
  )
}

console.log('[test] PNG -> JPEG (quality 80)')
const jpeg = await compress(2, png.buffer.slice(png.byteOffset, png.byteOffset + png.length), 'png', 'jpeg', 80)
assert(jpeg.type === 'done', '压缩成功返回 done')
{
  const head = new Uint8Array(jpeg.buffer, 0, 3)
  assert(head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff, '输出为合法 JPEG（FFD8FF 魔数）')
}

console.log('[test] PNG -> PNG（无损重编码）')
const pngOut = await compress(3, png.buffer.slice(png.byteOffset, png.byteOffset + png.length), 'png', 'png', 100)
assert(pngOut.type === 'done', '压缩成功返回 done')
{
  const head = new Uint8Array(pngOut.buffer, 0, 4)
  assert(
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47,
    '输出为合法 PNG（89504E47 魔数）'
  )
}

console.log('[test] WebP 回环：WebP -> JPEG')
const jpeg2 = await compress(4, webp.buffer, 'webp', 'jpeg', 75)
assert(jpeg2.type === 'done', 'WebP 解码再编码成功')
assert(jpeg2.size > 0, `输出非空（${jpeg2.size} 字节）`)

console.log('[test] 错误路径：非法数据')
const bad = await compress(5, new ArrayBuffer(16), 'png', 'webp', 75)
assert(bad.type === 'error', '非法输入返回 error 而非崩溃')

console.log('\n全部测试通过 ✓')
