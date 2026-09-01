export default defineAppConfig({
  pages: ['pages/index/index'],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#ffffff',
    navigationBarTitleText: 'Kix 图片压缩',
    navigationBarTextStyle: 'black',
    backgroundColor: '#f4f5f7',
  },
  // Worker 代码根目录（dist/workers，由 esbuild 产物拷贝而来）
  workers: 'workers',
})
