export type SourceType = 'jpeg' | 'png' | 'webp'
export type OutputType = 'jpeg' | 'png' | 'webp'

export interface ImageItem {
  id: string
  /** 原文件名（去扩展名，用于结果命名展示） */
  name: string
  /** 原图临时文件路径 */
  originalPath: string
  /** 缩略图显示地址（http://tmp 兜底为 base64 data URL） */
  thumbSrc?: string
  originalSize: number
  status: 'pending' | 'processing' | 'complete' | 'error'
  /** 压缩结果文件路径（USER_DATA_PATH 下） */
  resultPath?: string
  resultSize?: number
  /** 该条结果使用的输出格式与质量 */
  outputType?: OutputType
  /** 源图片实际格式（压缩时检测） */
  sourceType?: SourceType
  qualityUsed?: number
  error?: string
  /** 压缩进度百分比（0-100，仅 processing 状态有值） */
  progress?: number
}
