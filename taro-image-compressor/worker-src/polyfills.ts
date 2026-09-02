/**
 * Worker 线程环境补齐。
 *
 * 微信小程序的 Worker 是一个精简的 JS 上下文：没有 ImageData、TextDecoder
 * 等浏览器/Node 全局对象，而 @jsquash 的编解码器胶水（Emscripten / wasm-bindgen）
 * 依赖它们。必须在加载任何 codec 胶水之前先执行本文件。
 */
const g: any = globalThis as any

// Emscripten 胶水在 worker 分支读取 self.location.href，而微信 worker
// 没有 self 全局（会抛 cannot read property 'location' of undefined）
if (typeof g.self === 'undefined') {
  g.self = g
}
if (!g.self.location) {
  g.self.location = { href: '' }
}

// 开发者工具的 worker 沙箱实现（ide extensions/worker/implement）在
// WXWebAssembly.instantiate 上报指标时引用 __global；缺失时抛
// ReferenceError: __global is not defined
if (typeof g.__global === 'undefined') {
  g.__global = g
}

// 同一上报逻辑随后调用 __global.requestIdleCallback（浏览器 API，
// 小程序 worker 没有）；用 setTimeout 模拟：立即以充足剩余时间执行回调。
// 该调用只是开发者工具的内部埋点，语义上无需精确定现。
if (typeof g.requestIdleCallback === 'undefined') {
  g.requestIdleCallback = (
    cb: (deadline: { didTimeout: boolean; timeRemaining: () => number }) => void
  ): number => {
    const start = Date.now()
    return setTimeout(
      () => cb({ didTimeout: false, timeRemaining: () => Math.max(0, 50 - (Date.now() - start)) }),
      1
    ) as unknown as number
  }
}
if (typeof g.cancelIdleCallback === 'undefined') {
  g.cancelIdleCallback = (id: number) => {
    clearTimeout(id)
  }
}

// wasm 解码器返回 RGBA 像素时构造 ImageData（鸭子类型：data/width/height）
if (typeof g.ImageData === 'undefined') {
  g.ImageData = class ImageData {
    data: Uint8ClampedArray
    width: number
    height: number
    constructor(data: Uint8ClampedArray | Uint8Array | number[], width: number, height?: number) {
      const clamped =
        data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray(data as any)
      this.data = clamped
      this.width = width
      this.height =
        height !== undefined ? height : Math.max(1, Math.floor(clamped.length / 4 / width))
    }
  }
}

// wasm-bindgen 胶水用 TextDecoder 解析 wasm 内抛出的错误信息
if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class TextDecoder {
    decode(input?: ArrayBuffer | ArrayBufferView | null): string {
      if (!input) return ''
      const bytes =
        input instanceof ArrayBuffer
          ? new Uint8Array(input)
          : new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      let out = ''
      let i = 0
      const n = bytes.length
      while (i < n) {
        const b = bytes[i]
        if (b < 0x80) {
          out += String.fromCharCode(b)
          i += 1
          continue
        }
        let codePoint = 0
        let seqLen = 0
        if (b >= 0xc2 && b < 0xe0) {
          codePoint = b & 0x1f
          seqLen = 1
        } else if (b >= 0xe0 && b < 0xf0) {
          codePoint = b & 0x0f
          seqLen = 2
        } else if (b >= 0xf0 && b < 0xf5) {
          codePoint = b & 0x07
          seqLen = 3
        } else {
          out += '\ufffd'
          i += 1
          continue
        }
        let valid = i + seqLen < n
        for (let k = 1; k <= seqLen && valid; k += 1) {
          const cont = bytes[i + k]
          if ((cont & 0xc0) !== 0x80) {
            valid = false
          } else {
            codePoint = (codePoint << 6) | (cont & 0x3f)
          }
        }
        if (!valid) {
          out += '\ufffd'
          i += 1
          continue
        }
        if (codePoint > 0xffff) {
          const offset = codePoint - 0x10000
          out += String.fromCharCode(
            0xd800 + (offset >> 10),
            0xdc00 + (offset & 0x3ff)
          )
        } else {
          out += String.fromCharCode(codePoint)
        }
        i += seqLen + 1
      }
      return out
    }
  }
}

// 部分 WASM 胶水在异常分支引用 WebAssembly.RuntimeError 等成员；
// 小程序内以 WXWebAssembly 补齐缺失的引用（不覆盖已存在的全局 WebAssembly）。
if (typeof g.WebAssembly === 'undefined' && typeof g.WXWebAssembly !== 'undefined') {
  g.WebAssembly = g.WXWebAssembly
}
try {
  if (g.WebAssembly && !g.WebAssembly.RuntimeError) {
    g.WebAssembly.RuntimeError = Error
  }
} catch {
  /* 宿主对象只读时忽略 */
}
