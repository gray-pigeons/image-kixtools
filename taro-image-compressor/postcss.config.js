// 阻断 postcss-loader 向上级目录（原 Web 项目）查找 postcss 配置。
// Taro 的 pxtransform 等插件由 Taro 构建管线自行注入，这里保持为空。
module.exports = {
  plugins: [],
}
