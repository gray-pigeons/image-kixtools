/**
 * Vendored from @jsquash/oxipng (codec/pkg/squoosh_oxipng.js, Apache-2.0,
 * Copyright 2020 Google Inc. / wasm-bindgen generated).
 *
 * 修改点（适配微信小程序 Worker）：
 *  1. init(wasmPath) 直接接收代码包路径，改用 WXWebAssembly.instantiate 加载，
 *     移除 fetch / WebAssembly.instantiateStreaming / import.meta.url 分支；
 *  2. TextDecoder 不带 { ignoreBOM, fatal } 选项：真机 Worker 运行于 no-ICU 的
 *     精简 Node.js，原生 TextDecoder 一旦传入 fatal 即抛 ERR_NO_ICU（非 fatal
 *     解码仅把非法序列替换为 U+FFFD，用于错误信息文本，无功能影响）；
 *  3. 移除包内 pre.js 的 ServiceWorker / Node polyfill（由 ../polyfills.ts 统一垫片）。
 */

let wasm;

let cachedTextDecoder = new TextDecoder('utf-8');

cachedTextDecoder.decode();

let cachedUint8Memory0 = null;
function getUint8Memory0() {
    if (cachedUint8Memory0 === null || cachedUint8Memory0.byteLength === 0) {
        cachedUint8Memory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8Memory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return cachedTextDecoder.decode(getUint8Memory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8Memory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedInt32Memory0 = null;
function getInt32Memory0() {
    if (cachedInt32Memory0 === null || cachedInt32Memory0.byteLength === 0) {
        cachedInt32Memory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32Memory0;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8Memory0().subarray(ptr / 1, ptr / 1 + len);
}
/**
* @param {Uint8Array} data
* @param {number} level
* @param {boolean} interlace
* @param {boolean} optimize_alpha
* @returns {Uint8Array}
*/
export function optimise(data, level, interlace, optimize_alpha) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.optimise(retptr, ptr0, len0, level, interlace, optimize_alpha);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_free(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
* @param {Uint8ClampedArray} data
* @param {number} width
* @param {number} height
* @param {number} level
* @param {boolean} interlace
* @param {boolean} optimize_alpha
* @returns {Uint8Array}
*/
export function optimise_raw(data, width, height, level, interlace, optimize_alpha) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.optimise_raw(retptr, ptr0, len0, width, height, level, interlace, optimize_alpha);
        var r0 = getInt32Memory0()[retptr / 4 + 0];
        var r1 = getInt32Memory0()[retptr / 4 + 1];
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_free(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

async function init(wasmPath) {
    const imports = {};
    imports.wbg = {};
    imports.wbg.__wbindgen_throw = function(arg0, arg1) {
        throw new Error(getStringFromWasm0(arg0, arg1));
    };

    // 微信小程序：通过 WXWebAssembly 从代码包路径加载（支持 .wasm.br）
    const result = await WXWebAssembly.instantiate(wasmPath, imports);

    wasm = result.instance.exports;
    init.__wbindgen_wasm_module = result.module;

    return wasm;
}

export default init;
