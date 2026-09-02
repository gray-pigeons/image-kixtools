import { useMemo, useRef, useState } from 'react'
import Taro from '@tarojs/taro'
import { Button, Image, Slider, Text, View } from '@tarojs/components'

import './index.scss'
import {
  compressor,
  copyFileQuiet,
  mimeOfPath,
  persistTempFile,
  readFileBase64,
  readFileBuffer,
  sanitizeFileName,
  unlinkQuiet,
  writeResultFile,
} from '../../services/compressor'
import { formatFileSize } from '../../utils/format'
import { detectSourceType, getPngDimensions } from '../../utils/image'
import type { ImageItem, OutputType, SourceType } from '../../types'

interface FormatMeta {
  type: OutputType
  label: string
  ext: string
  defaultQuality: number
}

const FORMATS: FormatMeta[] = [
  { type: 'webp', label: 'WebP', ext: 'webp', defaultQuality: 75 },
  { type: 'jpeg', label: 'JPEG', ext: 'jpg', defaultQuality: 75 },
  { type: 'png', label: 'PNG', ext: 'png', defaultQuality: 100 },
]

/** 单文件体积上限（原始文件） */
const MAX_FILE_SIZE = 20 * 1024 * 1024
/** 解码后总像素上限（防御超大尺寸图导致内存溢出） */
const MAX_PIXELS = 40_000_000

let uid = 0
const nextId = () => `img-${Date.now().toString(36)}-${(uid += 1)}`

function baseName(name: string, path: string) {
  const raw = name || path.split('?')[0].split('/').pop() || 'image'
  return raw.replace(/\.[^.]+$/, '') || 'image'
}

export default function Index() {
  const [images, setImages] = useState<ImageItem[]>([])
  const [outputType, setOutputType] = useState<OutputType>('webp')
  const [quality, setQuality] = useState(75)
  const [running, setRunning] = useState(false)

  // 以 ref 作为单一数据源，规避异步队列与 React 渲染时序竞态
  const imagesRef = useRef<ImageItem[]>([])
  const runningRef = useRef(false)
  const optionsRef = useRef({ outputType, quality })

  optionsRef.current = { outputType, quality }

  const currentFormat = FORMATS.find((f) => f.type === outputType)!
  const showQuality = outputType !== 'png'

  const updateItem = (id: string, patch: Partial<ImageItem>) => {
    imagesRef.current = imagesRef.current.map((img) =>
      img.id === id ? { ...img, ...patch } : img
    )
    setImages(imagesRef.current)
  }

  const stats = useMemo(() => {
    const done = images.filter((i) => i.status === 'complete' && i.resultSize != null)
    const before = done.reduce((sum, i) => sum + i.originalSize, 0)
    const after = done.reduce((sum, i) => sum + (i.resultSize || 0), 0)
    const saved = before > 0 ? Math.round(((before - after) / before) * 100) : 0
    return { count: done.length, before, after, saved }
  }, [images])

  /** 已完成条目与当前设置不一致时，提示重新压缩 */
  const hasStale = images.some(
    (i) =>
      i.status === 'complete' &&
      (i.outputType !== outputType ||
        (outputType !== 'png' && i.qualityUsed !== quality))
  )

  const processItem = async (item: ImageItem) => {
    const { outputType: outType, quality: q } = optionsRef.current
    const fmt = FORMATS.find((f) => f.type === outType)!
    updateItem(item.id, { status: 'processing', error: undefined, progress: 0 })

    // 进度展示：Worker 只上报阶段节点（20 解码 / 60 编码），大图在单阶段内
    // 耗时很久，这里定时向当前阶段上限渐近爬升，让百分比持续推进
    let cap = 10
    let shown = 0
    let lastShown = -1
    const tick = setInterval(() => {
      const next = Math.min(cap - 1, shown + Math.max(0.8, (cap - shown) * 0.08))
      shown = next
      const rounded = Math.floor(next)
      if (rounded !== lastShown) {
        lastShown = rounded
        updateItem(item.id, { progress: rounded })
      }
    }, 200)

    const stopTick = () => clearInterval(tick)

    try {
      const buffer = await readFileBuffer(item.originalPath)
      if (!buffer.byteLength) throw new Error('无法读取图片文件')

      if (buffer.byteLength > MAX_FILE_SIZE) {
        throw new Error('图片超过 20MB，暂不支持')
      }

      const sourceType: SourceType | null = detectSourceType(
        item.originalPath,
        item.name,
        buffer
      )
      if (!sourceType) {
        throw new Error('不支持的格式（支持 JPEG / PNG / WebP）')
      }

      if (sourceType === 'png') {
        const dims = getPngDimensions(buffer)
        if (dims && dims.width * dims.height > MAX_PIXELS) {
          throw new Error('图片尺寸过大（超过 4000 万像素）')
        }
      }

      const result = await compressor.compress(
        buffer,
        sourceType,
        outType,
        q,
        (p) => {
          if (p > cap) cap = p
        }
      )
      const outBuffer = result.buffer
      if (!outBuffer.byteLength) throw new Error('压缩失败')
      // oxipng 在真机失败的诊断信息（vConsole / 真机调试可见）
      if (result.engineError) {
        console.warn('[png] oxipng 不可用，已用基础编码:', result.engineError)
      }

      const resultPath = await writeResultFile(outBuffer, fmt.ext, item.name)
      // 从实际写入路径提取文件名（含短后缀），用于发送/保存时的命名展示
      const resultName = resultPath.split('/').pop()?.replace(/\.[^.]+$/, '') || item.name
      stopTick()
      updateItem(item.id, {
        status: 'complete',
        resultPath,
        resultName,
        resultSize: outBuffer.byteLength,
        outputType: outType,
        sourceType,
        qualityUsed: q,
        progress: undefined,
        engine: result.engine,
        engineError: result.engineError,
      })
    } catch (e: any) {
      stopTick()
      updateItem(item.id, {
        status: 'error',
        error: e?.message || '处理失败',
        progress: undefined,
      })
    }
  }

  const pump = async () => {
    if (runningRef.current) return
    runningRef.current = true
    setRunning(true)
    try {
      for (;;) {
        const next = imagesRef.current.find((i) => i.status === 'pending')
        if (!next) break
        await processItem(next)
      }
    } finally {
      runningRef.current = false
      setRunning(false)
    }
  }

  const addFiles = async (files: { path: string; name?: string; size: number }[]) => {
    if (!files.length) return
    // 临时路径可能是 http://tmp/...（开发者工具），复制到用户目录后再使用
    const persisted = await Promise.all(
      files.map(async (f) => ({ ...f, path: await persistTempFile(f.path) }))
    )
    // 持久化仍失败（路径还是 http://）时，读成 base64 data URL 作为缩略图兜底
    const withThumb = await Promise.all(
      persisted.map(async (f) => {
        if (!/^https?:\/\//i.test(f.path) || f.size > 8 * 1024 * 1024) return f
        const base64 = await readFileBase64(f.path)
        return base64 ? { ...f, thumbSrc: `data:${mimeOfPath(f.path)};base64,${base64}` } : f
      })
    )
    const items: ImageItem[] = withThumb.map((f) => ({
      id: nextId(),
      name: baseName(f.name || '', f.path),
      originalPath: f.path,
      thumbSrc: f.thumbSrc,
      originalSize: f.size,
      status: 'pending',
    }))
    imagesRef.current = [...imagesRef.current, ...items]
    setImages(imagesRef.current)
    pump()
  }

  const pickFromAlbum = async () => {
    try {
      const res = await Taro.chooseMedia({
        count: 9,
        mediaType: ['image'],
        sizeType: ['original'],
        sourceType: ['album', 'camera'],
      })
      addFiles(
        (res.tempFiles || []).map((f: any) => ({
          path: f.tempFilePath,
          size: f.size,
        }))
      )
    } catch {
      /* 用户取消 */
    }
  }

  const pickFromChat = async () => {
    try {
      const res = await wx.chooseMessageFile({ count: 9, type: 'image' })
      addFiles(
        (res.tempFiles || []).map((f: any) => ({
          path: f.path,
          name: f.name,
          size: f.size,
        }))
      )
    } catch {
      /* 用户取消 */
    }
  }

  const recompressAll = () => {
    imagesRef.current = imagesRef.current.map((i) => {
      if (i.resultPath) unlinkQuiet(i.resultPath)
      if (i.status === 'complete' || i.status === 'error') {
        return {
          ...i,
          status: 'pending' as const,
          error: undefined,
          resultPath: undefined,
          resultName: undefined,
          resultSize: undefined,
          progress: undefined,
          engine: undefined,
          engineError: undefined,
        }
      }
      return i
    })
    setImages(imagesRef.current)
    pump()
  }

  /** 是否为我们持久化到 USER_DATA_PATH 的源图副本（src_ 前缀，可安全删除） */
  const isOwnedSourceCopy = (path?: string) =>
    !!path &&
    path.startsWith(`${Taro.env.USER_DATA_PATH}/`) &&
    path.includes('/src_')

  const removeItem = (id: string) => {
    const target = imagesRef.current.find((i) => i.id === id)
    if (target?.resultPath) unlinkQuiet(target.resultPath)
    if (isOwnedSourceCopy(target?.originalPath)) unlinkQuiet(target.originalPath)
    imagesRef.current = imagesRef.current.filter((i) => i.id !== id)
    setImages(imagesRef.current)
  }

  const clearAll = () => {
    imagesRef.current.forEach((i) => {
      unlinkQuiet(i.resultPath)
      if (isOwnedSourceCopy(i.originalPath)) unlinkQuiet(i.originalPath)
    })
    imagesRef.current = []
    setImages([])
  }

  const previewItem = async (item: ImageItem) => {
    if (!item.resultPath) return
    try {
      await Taro.previewImage({ urls: [item.resultPath], current: item.resultPath })
    } catch {
      Taro.showToast({ title: '该格式暂不支持预览，可保存后查看', icon: 'none' })
    }
  }

  const saveToAlbum = (filePath: string): Promise<boolean> => {
    return new Promise((resolve) => {
      Taro.saveImageToPhotosAlbum({
        filePath,
        success: () => resolve(true),
        fail: (err: any) => {
          const msg = err?.errMsg || ''
          if (msg.includes('auth deny') || msg.includes('authorize')) {
            Taro.showModal({
              title: '需要相册权限',
              content: '请在设置中开启「保存到相册」权限',
              confirmText: '去设置',
            }).then((res) => {
              if (res.confirm) {
                Taro.openSetting({}).then(() => resolve(false))
              } else {
                resolve(false)
              }
            })
          } else {
            resolve(false)
          }
        },
      })
    })
  }

  const saveItem = async (item: ImageItem) => {
    if (!item.resultPath) return
    const fmt = FORMATS.find((f) => f.type === item.outputType)!
    const defaultName = item.resultName || item.name

    // 二次确认 + 自定义名称（editable 需基础库 >= 2.17.1，
    // 不支持的环境退化为普通确认框，content 为空时使用默认名）
    // 注意：相册内文件名由微信/系统强制生成（安卓 mmexport+时间戳），
    // 自定义名称实际作用于文件本体（「发送」为文件时保留）
    let nameToUse = defaultName
    let confirmed = false
    try {
      const res = await Taro.showModal({
        title: '保存到相册',
        content: defaultName,
        editable: true,
        placeholderText: defaultName,
        confirmText: '保存',
        cancelText: '取消',
      })
      confirmed = !!res.confirm
      const edited = (res.content || '').trim()
      if (edited) nameToUse = sanitizeFileName(edited)
    } catch {
      /* 交互失败不保存，避免误写相册 */
      return
    }
    if (!confirmed) return

    // 自定义名称应用到条目（「发送」为文件时使用该名）
    if (nameToUse !== defaultName) {
      updateItem(item.id, { resultName: nameToUse })
    }

    // 部分机型保存时会沿用物理文件名：自定义名时生成重命名副本再保存
    let savePath = item.resultPath
    if (nameToUse !== defaultName) {
      const ext = fmt.ext
      // 目标已存在（同名二次保存）时加短随机重试一次
      const candidates = [
        nameToUse,
        `${nameToUse}_${Date.now().toString(36).slice(-4)}${Math.floor(Math.random() * 36).toString(36)}`,
      ]
      for (const cand of candidates) {
        if (await copyFileQuiet(item.resultPath, `${Taro.env.USER_DATA_PATH}/${cand}.${ext}`)) {
          savePath = `${Taro.env.USER_DATA_PATH}/${cand}.${ext}`
          break
        }
      }
      // 副本生成失败（重名等）时回退原名保存
    }

    const ok = await saveToAlbum(savePath)
    if (savePath !== item.resultPath) unlinkQuiet(savePath) // 清理重命名副本
    Taro.showToast({
      title: ok ? '已保存（相册内名称由系统生成）' : '保存失败，可尝试「发送」为文件',
      icon: 'none',
    })
  }

  const shareItem = (item: ImageItem) => {
    if (!item.resultPath) return
    const fmt = FORMATS.find((f) => f.type === item.outputType)!
    wx.shareFileMessage({
      filePath: item.resultPath,
      // 结果文件名：原名_短后缀.扩展名（文件已按此名写入，保持一致）
      fileName: `${item.resultName || item.name}.${fmt.ext}`,
      fail: () => {
        /* 用户取消或环境不支持 */
      },
    })
  }

  const saveAll = async () => {
    const done = imagesRef.current.filter((i) => i.status === 'complete' && i.resultPath)
    if (!done.length) return
    // 批量保存前二次确认（多张写入相册，避免误触）
    try {
      const res = await Taro.showModal({
        title: '批量保存到相册',
        content: `将以现有文件名保存 ${done.length} 张图片到相册`,
        confirmText: '保存',
        cancelText: '取消',
      })
      if (!res.confirm) return
    } catch {
      return
    }
    Taro.showLoading({ title: '保存中...', mask: true })
    let ok = 0
    for (const item of done) {
      if (await saveToAlbum(item.resultPath!)) ok += 1
      await new Promise((r) => setTimeout(r, 300))
    }
    Taro.hideLoading()
    const failed = done.length - ok
    Taro.showToast({
      title:
        failed > 0
          ? `已保存 ${ok} 张，${failed} 张失败（可单独「发送」）`
          : `已保存 ${done.length} 张到相册`,
      icon: failed > 0 ? 'none' : 'success',
    })
  }

  return (
    <View className="page">
      <View className="hero">
        <Text className="hero-title">Kix 图片压缩</Text>
        <Text className="hero-tagline">
          WASM 本地压缩 · 图片不上传 · 隐私安全
        </Text>
      </View>

      <View className="card">
        <Text className="section-title">输出格式</Text>
        <View className="format-grid">
          {FORMATS.map((fmt) => (
            <View
              key={fmt.type}
              className={`format-btn ${outputType === fmt.type ? 'active' : ''}`}
              onClick={() => {
                if (running) return
                setOutputType(fmt.type)
                setQuality(fmt.defaultQuality)
              }}
            >
              {fmt.label}
            </View>
          ))}
        </View>

        {outputType === 'png' && (
          <Text className="pick-hint">
            PNG 为无损格式，输出经 oxipng 无损优化；JPEG/WebP 照片转 PNG 体积通常反而增大
          </Text>
        )}

        {showQuality && (
          <View className="quality-row">
            <Text className="quality-label">质量</Text>
            <Slider
              className="quality-slider"
              min={1}
              max={100}
              step={1}
              value={quality}
              activeColor="#2563eb"
              blockSize={24}
              blockColor="#2563eb"
              onChange={(e) => setQuality(e.detail.value)}
            />
            <Text className="quality-value">{quality}</Text>
          </View>
        )}
      </View>

      <View className="card">
        <Button className="btn-primary" onClick={pickFromAlbum}>
          选择图片（相册 / 拍照）
        </Button>
        <Button className="btn-secondary" onClick={pickFromChat}>
          从聊天文件中选择
        </Button>
        <Text className="pick-hint">支持 JPEG / PNG / WebP，每次最多 9 张</Text>
      </View>

      {hasStale && (
        <View className="stale-tip">
          <Text className="stale-text">格式或质量已调整</Text>
          <View className="stale-btn" onClick={recompressAll}>
            重新压缩
          </View>
        </View>
      )}

      {images.length > 0 && (
        <View className="card">
          <View className="list-header">
            <Text className="section-title">
              图片列表
              {stats.count > 0 && (
                <Text className="stats">
                  {'  '}已压缩 {stats.count} 张，共 {formatFileSize(stats.before)} →{' '}
                  {formatFileSize(stats.after)}
                  {stats.saved > 0
                    ? `，节省 ${stats.saved}%`
                    : stats.saved < 0
                      ? `，增大 ${-stats.saved}%`
                      : ''}
                </Text>
              )}
            </Text>
            {images.length > 1 && (
              <Text className="link-danger" onClick={clearAll}>
                清空
              </Text>
            )}
          </View>

          {images.map((item) => {
            const fmt = FORMATS.find((f) => f.type === item.outputType)
            const ratio =
              item.status === 'complete' && item.resultSize != null
                ? Math.round(((item.originalSize - item.resultSize) / item.originalSize) * 100)
                : null
            return (
              <View className="list-item" key={item.id}>
                <Image
                  className="thumb"
                  src={item.thumbSrc || item.originalPath}
                  mode="aspectFill"
                  lazyLoad
                />
                <View className="item-body">
                  <View className="item-name-row">
                    <Text className="item-name">{item.name}</Text>
                    {item.status === 'complete' && fmt && (
                      <Text className="badge">
                        {item.sourceType && item.sourceType !== item.outputType
                          ? `${FORMATS.find((f) => f.type === item.sourceType)?.label ?? ''} → ${fmt.label}`
                          : fmt.label}
                        {item.outputType === 'png' && item.engine === 'png' && '·基础'}
                        {item.outputType === 'png' && item.engine === 'original' && '·原图'}
                      </Text>
                    )}
                  </View>

                  <View className="item-status">
                    {item.status === 'pending' && <Text className="status-pending">等待中</Text>}
                    {item.status === 'processing' && (
                      <Text className="status-processing">
                        压缩中...{item.progress != null ? ` ${item.progress}%` : ''}
                      </Text>
                    )}
                    {item.status === 'error' && (
                      <Text className="status-error" userSelect>
                        {item.error || '处理失败'}
                      </Text>
                    )}
                    {item.status === 'complete' && item.resultSize != null && (
                      <Text className="status-done">
                        {item.engine === 'original'
                          ? `${formatFileSize(item.resultSize)}（已是最优，保持原图）`
                          : `${formatFileSize(item.originalSize)} → ${formatFileSize(item.resultSize)}${
                              ratio && ratio > 0
                                ? `（小 ${ratio}%）`
                                : ratio && ratio < 0
                                  ? `（体积增大 ${-ratio}%）`
                                  : ''
                            }`}
                      </Text>
                    )}
                  </View>

                  {item.status === 'complete' && (
                    <View className="item-actions">
                      <Text className="action" onClick={() => previewItem(item)}>
                        预览
                      </Text>
                      <Text className="action" onClick={() => saveItem(item)}>
                        存相册
                      </Text>
                      <Text className="action" onClick={() => shareItem(item)}>
                        发送
                      </Text>
                    </View>
                  )}
                </View>

                <Text className="item-remove" onClick={() => removeItem(item.id)}>
                  ✕
                </Text>
              </View>
            )
          })}

          {stats.count > 1 && (
            <Button className="btn-primary save-all" onClick={saveAll}>
              全部保存到相册（{stats.count} 张 · 共 {formatFileSize(stats.before)} →{' '}
              {formatFileSize(stats.after)}）
            </Button>
          )}
        </View>
      )}

      {images.length === 0 && (
        <View className="empty">
          <Text className="empty-title">还没有图片</Text>
          <Text className="empty-sub">
            压缩在手机本地完成（WebAssembly），原图与结果均不会上传
          </Text>
        </View>
      )}

      <View className="footer">
        <Text className="footer-text">
          基于 Squoosh WASM 编解码器（MozJPEG / libwebp / oxipng）
        </Text>
      </View>
    </View>
  )
}
