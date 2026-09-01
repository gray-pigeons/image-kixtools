import { defineConfig, type UserConfigExport } from '@tarojs/cli'

import devConfig from './dev'
import prodConfig from './prod'

export default defineConfig<'webpack5'>(async (merge) => {
  const baseConfig: UserConfigExport<'webpack5'> = {
    projectName: 'taro-image-compressor',
    date: '2026-9-1',
    designWidth: 750,
    deviceRatio: { 640: 2.34 / 2, 750: 1, 375: 2, 828: 1.81 / 2 },
    sourceRoot: 'src',
    outputRoot: 'dist',
    plugins: [],
    framework: 'react',
    compiler: { type: 'webpack5', prebundle: { enable: false } },
    cache: { enable: false },
    mini: {
      postcss: {
        pxtransform: { enable: true, config: {} },
        cssModules: { enable: false },
        url: { enable: true, config: { limit: 1024 } },
        tailwindcss: { enable: false },
      },
      // Worker（esbuild 产物，仅 JS）与 brotli 压缩后的 WASM 模块直接拷贝进代码包。
      // 注意：wasm 文件必须位于 worker 目录之外（worker 目录只会打包 .js 文件）。
      copy: {
        patterns: [
          { from: 'workers/', to: 'dist/workers/' },
          { from: 'wasm/', to: 'dist/wasm/' },
        ],
        options: {},
      },
    },
    h5: {},
  }

  if (process.env.NODE_ENV === 'development') {
    return merge({}, baseConfig, devConfig)
  }
  return merge({}, baseConfig, prodConfig)
})
