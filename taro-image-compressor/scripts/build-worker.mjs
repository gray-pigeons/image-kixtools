/**
 * 将 worker-src 打包为微信小程序可用的 Worker（CommonJS、单文件）。
 *
 * Worker 线程只支持 CommonJS require，且目录内只打包 .js 文件，
 * 因此用 esbuild 把 TS 源码与 @jsquash 编解码器胶水内联成一个 workers/index.js，
 * WASM 二进制由 pack-wasm.mjs 单独处理并放在 worker 目录外。
 */
import { mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { build } from 'esbuild'

mkdirSync('workers', { recursive: true })

// 构建标识：git 短哈希 + 时间戳，worker 启动时打印，用于确认实际运行的版本
let buildStamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
try {
  buildStamp = `${execSync('git rev-parse --short HEAD').toString().trim()} ${buildStamp}`
} catch {
  /* 无 git 环境时仅用时间戳 */
}

/**
 * 构建期改写 @jsquash 的 Emscripten 胶水：
 *
 * 胶水内 `ENVIRONMENT_IS_WORKER = typeof importScripts == "function"`，
 * 微信开发者工具的 worker 沙箱定义了 importScripts，导致走 worker 分支
 * 读取 self.location.href，而该沙箱的作用域没有 self（运行时垫片不生效），
 * 抛出 cannot read property 'location' of undefined。
 *
 * 这里直接把判定改为 false，配合注入的 instantiateWasm（WXWebAssembly），
 * 所有 worker/web 专属的加载分支都不会执行，路径解析完全由 locateFile 接管。
 */
const patchJsquashGlue = {
  name: 'patch-jsquash-glue',
  setup(build) {
    build.onLoad({ filter: /node_modules\/@jsquash\/.*\/codec\/.*\.js$/ }, async (args) => {
      const fs = await import('node:fs')
      let code = fs.readFileSync(args.path, 'utf8')
      const before = code
      code = code.replace(
        /ENVIRONMENT_IS_WORKER=typeof importScripts=="function"/g,
        'ENVIRONMENT_IS_WORKER=false'
      )
      // worker 运行时垫片会定义 window（供开发者工具埋点代码访问），
      // 这里同步禁用 web 分支，避免 Emscripten 因 window 存在而走浏览器加载路径
      code = code.replace(
        /ENVIRONMENT_IS_WEB=typeof window=="object"/g,
        'ENVIRONMENT_IS_WEB=false'
      )
      // 防御：万一未来版本改写判定写法，兜底消灭对 self.location 的直接访问
      code = code.replace(/scriptDirectory=self\.location\.href/g, 'scriptDirectory=""')
      if (code === before) {
        console.warn(`[build-worker] 未匹配到补丁点: ${args.path}`)
      }
      return { contents: code, loader: 'js' }
    })
  },
}

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
  define: { __BUILD_STAMP__: JSON.stringify(buildStamp) },
  plugins: [patchJsquashGlue],
})

console.log('[build-worker] workers/index.js 已生成')

if (result?.metafile) {
  for (const [out, entry] of Object.entries(result.metafile.outputs)) {
    console.log(`[build-worker] ${out}: ${(entry.bytes / 1024).toFixed(1)} KB`)
  }
}
