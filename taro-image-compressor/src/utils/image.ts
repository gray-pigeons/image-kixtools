import type { SourceType } from '../types'

/** 通过魔数识别图片真实格式（JPEG / PNG / WebP） */
export function sniffImageType(buffer: ArrayBuffer): SourceType | null {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 16))
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  ) {
    return 'png'
  }
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'webp'
  }
  return null
}

/** 扩展名优先，失败时回退到魔数识别 */
export function detectSourceType(
  path: string,
  name: string,
  buffer: ArrayBuffer
): SourceType | null {
  const matched = ((name || path).toLowerCase().split('?')[0].match(/\.([a-z0-9]+)$/) ||
    []) as string[]
  const ext = matched[1] || ''
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
  if (ext === 'png') return 'png'
  if (ext === 'webp') return 'webp'
  return sniffImageType(buffer)
}

/** 读取 PNG IHDR 尺寸（用于解码前的防御性检查） */
export function getPngDimensions(
  buffer: ArrayBuffer
): { width: number; height: number } | null {
  if (buffer.byteLength < 24) return null
  const v = new DataView(buffer)
  if (v.getUint32(0) !== 0x89504e47) return null
  return { width: v.getUint32(16), height: v.getUint32(20) }
}
