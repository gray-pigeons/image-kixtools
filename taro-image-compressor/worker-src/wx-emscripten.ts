/**
 * 用 WXWebAssembly 实例化 Emscripten 编解码模块。
 *
 * Squoosh 系 codec（@jsquash 的 jpeg/webp）默认通过 fetch + import.meta.url
 * 加载 wasm，这在小程序 Worker 里不可用。Emscripten 支持注入 instantiateWasm
 * 回调，我们改用 WXWebAssembly.instantiate(代码包路径, imports) 完成加载。
 */

export function initEmscriptenCodec(
  factory: EmscriptenFactory,
  wasmPath: string
): Promise<any> {
  // 开发者工具的埋点包装层（ide extensions/worker/implement）会在
  // WXWebAssembly.instantiate 的回调里抛出 TypeError（访问未定义对象的
  // location 等）。这类错误与我们的代码无关且往往瞬时，失败后整体重建
  // 模块重试；真机无此埋点层，不会走到重试分支。
  const MAX_ATTEMPTS = 3
  return attempt(1)

  function attempt(n: number): Promise<any> {
    return once().catch((err) => {
      if (n >= MAX_ATTEMPTS) throw err
      console.warn(
        `[worker] WASM 实例化失败（第 ${n} 次），${50 * n}ms 后重试: ${err && err.message}`
      )
      return new Promise((r) => setTimeout(r, 50 * n)).then(() => attempt(n + 1))
    })
  }

  function once(): Promise<any> {
    let wasmReady: Promise<any> | null = null

    const mod = factory({
      // 阻止 Emscripten 自动执行入口逻辑
      noInitialRun: true,
      // 避免 Emscripten 走 new URL(...) 解析 wasm 地址的分支
      locateFile: () => wasmPath,
      instantiateWasm: (
        imports: Record<string, any>,
        receiveInstance: (instance: any) => void
      ) => {
        wasmReady = WXWebAssembly.instantiate(wasmPath, imports)
        wasmReady!.then(
          (res) => receiveInstance(res.instance),
          () => {
            /* 加载失败：由下方 Promise.all 产生 reject */
          }
        )
        // 返回空对象表示异步初始化，Emscripten 会等待 receiveInstance 回调
        return {}
      },
    })

    if (!wasmReady) {
      return Promise.reject(new Error(`WASM 模块未启动加载: ${wasmPath}`))
    }

    // mod.ready 在 wasm 实例化 + 运行时初始化完成后 resolve；
    // 与 wasmReady 一起等待，确保任一失败都能传导出去。
    return Promise.all([mod.ready ?? mod, wasmReady]).then(() => mod)
  }
}
