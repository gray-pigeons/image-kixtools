/**
 * 小程序 UI 自动化测试（需在装有微信开发者工具的 Win/Mac 机器上运行）。
 *
 * 使用 miniprogram-automator 驱动真实开发者工具：
 *   1. 启动工具并打开本项目（使用 project.config.json 中的真实 appid）
 *   2. 校验首页关键 UI 渲染
 *   3. mock wx.chooseMedia 注入本地测试图片，走完整压缩流程
 *   4. mock 保存相册接口，验证「存相册」交互
 *
 * 运行前置：
 *   - 已安装微信开发者工具，并在「设置 → 安全设置」中开启服务端口
 *   - 已执行 npm run build:weapp 生成 dist 产物
 *
 * 运行：npm run test:ui
 */
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import automator from 'miniprogram-automator'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectPath = path.resolve(__dirname, '..')

// ---- 生成测试 PNG（64x64 RGBA 渐变），与 test-worker.mjs 保持一致 ----
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
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4)
    raw[row] = 0
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

const fixtureDir = path.join(projectPath, 'test', 'fixtures')
mkdirSync(fixtureDir, { recursive: true })
const fixturePath = path.join(fixtureDir, 'test.png')
writeFileSync(fixturePath, makeTestPng())

// ---- 断言工具 ----
let passed = 0
function assert(cond, message) {
  if (!cond) throw new Error(`断言失败: ${message}`)
  passed += 1
  console.log(`  ✓ ${message}`)
}

async function textOf(el) {
  if (!el) return ''
  return (await el.text()).trim()
}

async function waitFor(fn, { timeout = 60000, interval = 500, label = '条件' } = {}) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${label}`)
    await new Promise((r) => setTimeout(r, interval))
  }
}

// ---- 主流程 ----
console.log('[ui-test] 启动微信开发者工具...')
const miniProgram = await automator.launch({
  projectPath,
  // 如开发者工具不在默认安装路径，请通过环境变量 WT_CLI_PATH 指定 cli：
  cliPath: process.env.WT_CLI_PATH,
})

try {
  const page = await miniProgram.reLaunch('/pages/index/index')
  await page.waitFor(1000)

  console.log('[ui-test] 首页渲染')
  const title = await page.$('.hero-title')
  assert((await textOf(title)) === 'Kix 图片压缩', '标题渲染正确')

  const formatBtns = await page.$$('.format-btn')
  assert(formatBtns.length === 3, '输出格式按钮共 3 个（WebP/JPEG/PNG）')
  assert((await textOf(formatBtns[0])) === 'WebP', '默认选中 WebP')

  const pickBtns = await page.$$('.btn-primary')
  assert(pickBtns.length >= 1, '「选择图片」按钮存在')

  console.log('[ui-test] mock 选图并走完整压缩流程')
  await miniProgram.mockWxMethod('chooseMedia', {
    errMsg: 'chooseMedia:ok',
    tempFiles: [{ tempFilePath: fixturePath, size: 0, fileType: 'image' }],
  })
  await miniProgram.mockWxMethod('saveImageToPhotosAlbum', {
    errMsg: 'saveImageToPhotosAlbum:ok',
  })

  await pickBtns[0].tap()

  // 等待压缩完成：出现「xx KB → xx KB」状态文本
  await waitFor(
    async () => {
      const done = await page.$('.status-done')
      return !!done && (await textOf(done)).includes('→')
    },
    { label: '压缩完成状态' }
  )
  const doneText = await textOf(await page.$('.status-done'))
  assert(doneText.includes('→'), `压缩结果显示（${doneText}）`)

  const actions = await page.$$('.item-actions .action')
  assert(actions.length === 3, '完成后出现 预览/存相册/发送 三个操作')

  console.log('[ui-test] mock 存相册')
  await actions[1].tap()
  await page.waitFor(1000)
  // saveImageToPhotosAlbum 已 mock 为成功；验证交互未导致条目进入错误状态
  const errorText = await page.$('.status-error')
  assert(!errorText, '存相册交互未产生错误状态（mock 成功路径）')

  console.log('[ui-test] 清空列表')
  const removeBtn = await page.$('.item-remove')
  if (removeBtn) {
    await removeBtn.tap()
    await page.waitFor(500)
    const remaining = await page.$$('.list-item')
    assert(remaining.length === 0, '删除条目后列表清空')
  }

  console.log(`\n全部 UI 测试通过 ✓（共 ${passed} 项）`)
} finally {
  await miniProgram.close()
}
