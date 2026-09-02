import Taro from '@tarojs/taro'

/** Worker -> 主线程消息 */
type WorkerMessage =
  | { type: 'done'; id: number; buffer: ArrayBuffer; size: number }
  | { type: 'error'; id: number; message: string }

interface PendingJob {
  resolve: (buffer: ArrayBuffer) => void
  reject: (error: Error) => void
}

/**
 * 压缩 Worker 的主线程封装。
 *
 * Worker 内通过 WXWebAssembly 加载 @jsquash（Squoosh WASM 移植）完成
 * 解码与编码，压缩结果以 ArrayBuffer 经 postMessage 回传（基础库 >= 2.20.2）。
 */
class CompressWorkerService {
  private worker: any = null
  private seq = 1
  private pending = new Map<number, PendingJob>()

  private ensureWorker() {
    if (this.worker) return this.worker
    const worker = wx.createWorker('workers/index.js')
    worker.onMessage((msg: WorkerMessage) => {
      if (!msg || typeof msg !== 'object') return
      const job = this.pending.get(msg.id)
      if (!job) return
      this.pending.delete(msg.id)
      if (msg.type === 'done' && msg.buffer) {
        job.resolve(msg.buffer)
      } else {
        job.reject(new Error(msg.message || '压缩失败'))
      }
    })
    // Worker 被系统回收时清空状态，下次调用自动重建
    if (typeof worker.onProcessKilled === 'function') {
      worker.onProcessKilled(() => this.reset())
    }
    this.worker = worker
    return worker
  }

  private reset() {
    for (const job of this.pending.values()) {
      job.reject(new Error('压缩线程已被回收，请重试'))
    }
    this.pending.clear()
    if (this.worker) {
      try {
        this.worker.terminate()
      } catch {
        /* noop */
      }
    }
    this.worker = null
  }

  compress(
    buffer: ArrayBuffer,
    sourceType: string,
    outputType: string,
    quality: number
  ): Promise<ArrayBuffer> {
    const worker = this.ensureWorker()
    const id = this.seq++
    return new Promise<ArrayBuffer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({
        type: 'compress',
        id,
        buffer,
        sourceType,
        outputType,
        quality,
      })
    })
  }
}

export const compressor = new CompressWorkerService()

/** 读取本地文件为二进制 */
export function readFileBuffer(filePath: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      success: (res) => resolve(res.data as ArrayBuffer),
      fail: (err) => reject(new Error(err.errMsg || '读取文件失败')),
    })
  })
}

/** 将压缩结果写入用户目录，返回文件路径 */
export function writeResultFile(buffer: ArrayBuffer, ext: string): Promise<string> {
  const fileName = `kix_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
  const filePath = `${Taro.env.USER_DATA_PATH}/${fileName}`
  return new Promise((resolve, reject) => {
    Taro.getFileSystemManager().writeFile({
      filePath,
      data: buffer,
      encoding: 'binary',
      success: () => resolve(filePath),
      fail: (err) => reject(new Error(err.errMsg || '写入文件失败')),
    })
  })
}

/**
 * 将临时文件复制到用户目录并返回新路径。
 *
 * 开发者工具模拟器的临时路径形如 http://tmp/xxx.png，新版基础库的
 * <Image> 组件已禁止 http 协议链接；复制到 USER_DATA_PATH 后得到的
 * wxfile://usr/... 路径在模拟器与真机上均可正常显示和读取。
 * 复制失败时退回原路径（真机临时路径本身可用）。
 */
export function persistTempFile(tempPath: string): Promise<string> {
  const rawExt = tempPath.split('?')[0].split('.').pop() || ''
  const ext = /^[a-zA-Z0-9]{1,5}$/.test(rawExt) ? rawExt.toLowerCase() : 'img'
  const fileName = `src_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
  const filePath = `${Taro.env.USER_DATA_PATH}/${fileName}`
  return new Promise((resolve) => {
    Taro.getFileSystemManager().copyFile({
      srcPath: tempPath,
      destPath: filePath,
      success: () => resolve(filePath),
      fail: () => resolve(tempPath),
    })
  })
}

/** 尽力删除文件，失败不抛错 */
export function unlinkQuiet(filePath?: string) {
  if (!filePath) return
  try {
    Taro.getFileSystemManager().unlink({ filePath, fail: () => {} })
  } catch {
    /* noop */
  }
}
