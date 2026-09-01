/** 微信小程序 Worker 线程内暴露的全局对象 */
declare const worker: {
  onMessage(callback: (message: any) => void): void
  postMessage(message: any): void
}

/** 小程序提供的 WebAssembly 加载接口，path 为代码包内路径（支持 .wasm / .wasm.br） */
declare const WXWebAssembly: {
  instantiate(path: string, imports: Record<string, any>): Promise<{
    instance: { exports: any }
    module: unknown
  }>
  Memory: any
  Table: any
  Global: any
}

/** Emscripten 模块工厂（Squoosh 风格，MODULARIZE 产物） */
declare type EmscriptenFactory = (options: Record<string, any>) => any
