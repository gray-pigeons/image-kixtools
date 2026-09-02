/**
 * 图片编解码封装（运行于微信小程序 Worker 线程）。
 *
 * - jpeg / webp：Squoosh 系 Emscripten 模块（@jsquash），通过
 *   initEmscriptenCodec 注入 instantiateWasm，由 WXWebAssembly 加载 .wasm.br
 * - png：wasm-bindgen 模块（@jsquash 修补版胶水）
 *
 * 解码得到 ImageData（鸭子类型：data/width/height），
 * 编码输出为紧凑的 ArrayBuffer，可直接经 postMessage 回传主线程。
 */
import webpDecFactory from '@jsquash/webp/codec/dec/webp_dec.js'
import webpEncFactory from '@jsquash/webp/codec/enc/webp_enc.js'
import mozjpegDecFactory from '@jsquash/jpeg/codec/dec/mozjpeg_dec.js'
import mozjpegEncFactory from '@jsquash/jpeg/codec/enc/mozjpeg_enc.js'
import { defaultOptions as webpDefaultOptions } from '@jsquash/webp/meta.js'
import { defaultOptions as jpegDefaultOptions } from '@jsquash/jpeg/meta.js'

import * as pngCodec from './vendor/squoosh_png.js'
import * as oxipng from './vendor/squoosh_oxipng.js'
import { initEmscriptenCodec } from './wx-emscripten'

export type RawImageData = {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

export type EmscriptenSourceType = 'jpeg' | 'webp'
export type EncodeOutputType = 'jpeg' | 'webp' | 'png'

const WASM_DIR = '/wasm'

const decoderCache: Partial<Record<EmscriptenSourceType, Promise<any>>> = {}
const encoderCache: Partial<Record<EmscriptenSourceType, Promise<any>>> = {}

function getDecoder(type: EmscriptenSourceType): Promise<any> {
  if (!decoderCache[type]) {
    const factory = type === 'jpeg' ? mozjpegDecFactory : webpDecFactory
    const path = type === 'jpeg' ? `${WASM_DIR}/mozjpeg_dec.wasm.br` : `${WASM_DIR}/webp_dec.wasm.br`
    decoderCache[type] = initEmscriptenCodec(factory as EmscriptenFactory, path)
  }
  return decoderCache[type]!
}

function getEncoder(type: Exclude<EncodeOutputType, 'png'>): Promise<any> {
  if (!encoderCache[type]) {
    const factory = type === 'jpeg' ? mozjpegEncFactory : webpEncFactory
    const path = type === 'jpeg' ? `${WASM_DIR}/mozjpeg_enc.wasm.br` : `${WASM_DIR}/webp_enc.wasm.br`
    encoderCache[type] = initEmscriptenCodec(factory as EmscriptenFactory, path)
  }
  return encoderCache[type]!
}

let pngReady: Promise<unknown> | null = null
function getPng(): Promise<unknown> {
  if (!pngReady) {
    pngReady = pngCodec.default(`${WASM_DIR}/squoosh_png_bg.wasm.br`)
  }
  return pngReady
}

let oxipngReady: Promise<unknown> | null = null
function getOxipng(): Promise<unknown> {
  if (!oxipngReady) {
    oxipngReady = oxipng.default(`${WASM_DIR}/squoosh_oxipng_bg.wasm.br`)
  }
  return oxipngReady
}

export async function decode(sourceType: string, buffer: ArrayBuffer): Promise<RawImageData> {
  if (sourceType === 'png') {
    await getPng()
    const result = await pngCodec.decode(new Uint8Array(buffer))
    if (!result || !result.width || !result.height) {
      throw new Error('PNG 解码失败')
    }
    return result as RawImageData
  }

  if (sourceType !== 'jpeg' && sourceType !== 'webp') {
    throw new Error(`暂不支持的图片格式: ${sourceType}`)
  }

  const mod = await getDecoder(sourceType)
  const result = mod.decode(buffer)
  if (!result || !result.width || !result.height) {
    throw new Error('图片解码失败')
  }
  return result as RawImageData
}

export interface EncodeResult {
  buffer: ArrayBuffer
  /** 实际使用的编码引擎（png 输出：oxipng=优化版 / png=基础回退） */
  engine: string
  /** oxipng 失败时的原因（用于真机诊断，透传到主线程展示） */
  engineError?: string
}

export async function encode(
  outputType: EncodeOutputType,
  image: RawImageData,
  quality: number
): Promise<EncodeResult> {
  if (outputType === 'png') {
    // 优先使用 oxipng 优化编码（自适应过滤策略搜索，PNG→PNG 时通常可进一步减小体积）；
    // 失败时回退到基础 PNG 编码器，并透传失败原因（真机 SIMD/内存限制等）
    try {
      await getOxipng()
      const out = oxipng.optimise_raw(
        image.data as Uint8ClampedArray,
        image.width,
        image.height,
        2, // oxipng 优化级别（Squoosh 默认），过高会显著增加耗时
        false, // interlace
        false // optimiseAlpha
      )
      if (out && out.length) {
        return { buffer: out.buffer as ArrayBuffer, engine: 'oxipng' }
      }
      throw new Error('oxipng 输出为空')
    } catch (err: any) {
      const reason = err?.message ? String(err.message).slice(0, 200) : String(err).slice(0, 200)
      console.warn('[codecs] oxipng 优化失败，回退基础 PNG 编码:', reason)
      await getPng()
      const out = await pngCodec.encode(image.data as Uint8Array, image.width, image.height)
      if (!out || !out.length) throw new Error('PNG 编码失败')
      // wasm-bindgen 胶水已 slice 出紧凑数组，直接取 buffer
      return { buffer: out.buffer as ArrayBuffer, engine: 'png', engineError: reason }
    }
  }

  if (outputType !== 'jpeg' && outputType !== 'webp') {
    throw new Error(`暂不支持的输出格式: ${outputType}`)
  }

  const mod = await getEncoder(outputType)
  const defaults = outputType === 'jpeg' ? jpegDefaultOptions : webpDefaultOptions
  const result = mod.encode(image.data, image.width, image.height, {
    ...defaults,
    quality,
  })
  if (!result) throw new Error('图片编码失败')

  // 防御性拷贝：编码结果可能是指向 wasm 线性内存的视图
  const copy = new Uint8Array(result.byteLength)
  copy.set(result)
  return { buffer: copy.buffer, engine: outputType }
}
