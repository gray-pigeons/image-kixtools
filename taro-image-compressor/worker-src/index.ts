/**
 * 压缩 Worker 入口。
 *
 * 消息协议（主线程 <-> Worker，二进制经 postMessage 复制传递，基础库 >= 2.20.2）：
 *   入： { type: 'compress', id, buffer, sourceType, outputType, quality }
 *   出： { type: 'progress', id, progress }（阶段节点：20 开始解码 / 60 开始编码）
 *      | { type: 'done', id, buffer, size, engine, engineError? }
 *      | { type: 'error', id, message }
 *
 * engine（png 输出专用）：'oxipng' 优化编码 / 'png' 基础回退 / 'original' 保持原图
 * （PNG→PNG 且重编码不小于原图时直接返回原字节，保证无损场景绝不变大）
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
      // WASM 解码/编码是同步黑盒，无法获取内部进度；
      // 只上报阶段节点，主线程负责渐近爬升展示
      worker.postMessage({ type: 'progress', id, progress: 20 })
      const imageData = await decode(sourceType, buffer)
      worker.postMessage({ type: 'progress', id, progress: 60 })
      const result = await encode(outputType as any, imageData, quality)
      let outBuffer = result.buffer
      let engine = result.engine
      // PNG→PNG 无损场景：重编码不小于原图时直接保持原字节，绝不变大
      if (sourceType === 'png' && outputType === 'png' && outBuffer.byteLength >= buffer.byteLength) {
        outBuffer = buffer
        engine = 'original'
      }
      worker.postMessage({
        type: 'done',
        id,
        buffer: outBuffer,
        size: outBuffer.byteLength,
        engine,
        engineError: result.engineError,
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
