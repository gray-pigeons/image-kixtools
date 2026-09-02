/**
 * 压缩 Worker 入口。
 *
 * 消息协议（主线程 <-> Worker，二进制经 postMessage 复制传递，基础库 >= 2.20.2）：
 *   入： { type: 'compress', id, buffer, sourceType, outputType, quality }
 *   出： { type: 'done', id, buffer, size } | { type: 'error', id, message }
 *
 * Worker 线程内全局暴露 worker 对象（无 wx API），
 * WASM 模块位于代码包 /wasm 目录（必须在 worker 目录之外）。
 */
import './polyfills'
import { decode, encode } from './codecs'

// 启动即打印构建标识，用于在控制台一眼确认实际运行的是哪个版本
console.info(`[worker] build: ${__BUILD_STAMP__}`)

interface CompressRequest {
  type: 'compress'
  id: number
  buffer: ArrayBuffer
  sourceType: string
  outputType: string
  quality: number
}

worker.onMessage((msg: CompressRequest) => {
  if (!msg || msg.type !== 'compress') return
  const { id, buffer, sourceType, outputType, quality } = msg

  Promise.resolve()
    .then(async () => {
      const imageData = await decode(sourceType, buffer)
      const outBuffer = await encode(outputType as any, imageData, quality)
      worker.postMessage({
        type: 'done',
        id,
        buffer: outBuffer,
        size: outBuffer.byteLength,
      })
    })
    .catch((err) => {
      // 附带堆栈前几帧，便于在图片列表中直接定位报错来源
      const message = (err && err.message) || String(err)
      const stack =
        err && err.stack
          ? ' [' + String(err.stack).split('\n').slice(0, 3).join(' <= ') + ']'
          : ''
      worker.postMessage({
        type: 'error',
        id,
        message: message + stack,
      })
    })
})
