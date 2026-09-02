import Taro from '@tarojs/taro'

/** Worker -> 主线程消息 */
type WorkerMessage =
  | {
      type: 'done'
      id: number
      buffer: ArrayBuffer
      size: number
      engine?: string
      engineError?: string
    }
  | { type: 'error'; id: number; message: string }
  | { type: 'progress'; id: number; progress: number }

export interface CompressResult {
  buffer: ArrayBuffer
  /** png 输出引擎：'oxipng' | 'png'(基础回退) | 'original'(保持原图) */
  engine?: string
  /** oxipng 失败原因（真机诊断用） */
  engineError?: string
}

interface PendingJob {
  resolve: (result: CompressResult) => void
  reject: (error: Error) => void
  onProgress?: (progress: number) => void
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
      // 阶段进度消息：仅回调，不结束任务
      if (msg.type === 'progress') {
        job.onProgress?.(msg.progress)
        return
      }
      this.pending.delete(msg.id)
      if (msg.type === 'done' && msg.buffer) {
        job.resolve({ buffer: msg.buffer, engine: msg.engine, engineError: msg.engineError })
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
    quality: number,
    onProgress?: (progress: number) => void
  ): Promise<CompressResult> {
    const worker = this.ensureWorker()
    const id = this.seq++
    return new Promise<CompressResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress })
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

/** 过滤文件名中的非法字符（保留中文/字母/数字/连字符/下划线/点） */
export function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n\t]/g, '').trim() || 'image'
}

/** 将压缩结果写入用户目录，返回文件路径。
 * 传入 baseName 时命名为 `${baseName}_${短后缀}.${ext}`（base36 时间戳 + 随机，
 *  共约 10 字符，唯一且短）；否则沿用 kix_ 前缀内部命名。 */
export function writeResultFile(
  buffer: ArrayBuffer,
  ext: string,
  baseName?: string
): Promise<string> {
  const stamp = Date.now().toString(36)
  const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0') // 2 位 base36 随机
  const fileName = baseName
    ? `${sanitizeFileName(baseName)}_${stamp}${rand}.${ext}`
    : `kix_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
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
 * 将临时文件持久化到本地目录并返回新路径。
 *
 * 开发者工具模拟器的临时路径形如 http://tmp/xxx.png，新版基础库的
 * <Image> 组件已禁止 http 协议链接。这里按可靠性依次尝试：
 *   1. saveFile：官方推荐的临时文件持久化方式
 *   2. copyFile：直接复制到 USER_DATA_PATH（保留扩展名，便于格式嗅探）
 *   3. readFile + writeFile：字节级兜底复制
 * 全部失败才回退原路径（真机临时路径本身可用）。
 */
export function persistTempFile(tempPath: string): Promise<string> {
  const fsm = Taro.getFileSystemManager()
  const rawExt = tempPath.split('?')[0].split('.').pop() || ''
  const ext = /^[a-zA-Z0-9]{1,5}$/.test(rawExt) ? rawExt.toLowerCase() : 'img'
  const fileName = `src_${Date.now()}_${Math.floor(Math.random() * 1e6)}.${ext}`
  const filePath = `${Taro.env.USER_DATA_PATH}/${fileName}`

  // 已是本地协议则无需处理（真机 wxfile:// 路径可直接使用）
  if (!/^https?:\/\//i.test(tempPath)) return Promise.resolve(tempPath)

  return new Promise((resolve) => {
    fsm.saveFile({
      tempFilePath: tempPath,
      success: (res) => {
        console.info('[persist] saveFile 成功:', res.savedFilePath)
        resolve(res.savedFilePath)
      },
      fail: (e1) => {
        fsm.copyFile({
          srcPath: tempPath,
          destPath: filePath,
          success: () => {
            console.info('[persist] copyFile 成功:', filePath)
            resolve(filePath)
          },
          fail: () => {
            fsm.readFile({
              filePath: tempPath,
              success: (read) => {
                fsm.writeFile({
                  filePath,
                  data: read.data,
                  success: () => {
                    console.info('[persist] readFile+writeFile 成功:', filePath)
                    resolve(filePath)
                  },
                  fail: () => {
                    console.warn('[persist] 全部持久化方式失败，回退原路径', e1)
                    resolve(tempPath)
                  },
                })
              },
              fail: () => {
                console.warn('[persist] 全部持久化方式失败，回退原路径', e1)
                resolve(tempPath)
              },
            })
          },
        })
      },
    })
  })
}

/** 读取文件为 base64（用于 http://tmp 路径的缩略图兜底显示） */
export function readFileBase64(filePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    Taro.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (res) => resolve(res.data as string),
      fail: () => resolve(null),
    })
  })
}

/** 根据扩展名推断 data URL 的 MIME 前缀 */
export function mimeOfPath(path: string): string {
  const ext = path.split('?')[0].split('.').pop()?.toLowerCase() || ''
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

/** 复制文件（静默失败返回 false），用于保存相册前按自定义名称生成副本 */
export function copyFileQuiet(src: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    Taro.getFileSystemManager().copyFile({
      srcPath: src,
      destPath: dest,
      success: () => resolve(true),
      fail: () => resolve(false),
    })
  })
}

/** 尽力删除文件，失败不抛错 */
export function unlinkQuiet(filePath?: string) {
  if (!filePath) return
  try {
    const fsm = Taro.getFileSystemManager()
    // 先预检存在性：真机上结果文件可能已被系统清理（保存相册/发送后转存、
    // 基础库清缓存等），对不存在的路径直接 unlink 会触发框架 error 日志
    fsm.access({
      path: filePath,
      success: () => fsm.unlink({ filePath, fail: () => {} }),
      fail: () => {
        /* 文件已不存在，无需删除 */
      },
    })
  } catch {
    /* noop */
  }
}
