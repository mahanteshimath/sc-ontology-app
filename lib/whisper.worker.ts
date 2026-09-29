/// <reference lib="webworker" />
/**
 * Whisper, in the browser, off the main thread.
 *
 * The audio never leaves the device: the model is downloaded once (then served from the browser
 * cache) and inference runs locally on WebGPU when the machine has it, WebAssembly when it does
 * not. That matters here more than in most apps - a governed analytics tool that streamed every
 * spoken question to a third-party speech API would be exporting business questions to a system
 * outside the governance boundary the rest of the project is built to enforce.
 *
 * Protocol (main thread -> worker):  { type: "load" } | { type: "transcribe", id, audio }
 * Protocol (worker -> main thread):  progress | ready | result | error
 */
import { pipeline, env } from "@huggingface/transformers"

// Only fetch from the model hub; never probe the app's own origin for model files.
env.allowLocalModels = false

// English-only base model: noticeably better than tiny on domain terms ("fill rate", "landed
// cost") while still ~80 MB quantized. The page can override it in the load message (from
// NEXT_PUBLIC_WHISPER_MODEL) for teams that self-host weights; the env var is read on the main
// thread because inlining process.env into a worker bundle is not something to rely on.
let MODEL = "Xenova/whisper-base.en"

type Transcriber = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>

let loading: Promise<{ asr: Transcriber; device: string }> | null = null
const files: Record<string, { loaded: number; total: number }> = {}

const post = (msg: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)

async function hasWebGPU(): Promise<boolean> {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    return Boolean(gpu && (await gpu.requestAdapter()))
  } catch {
    return false
  }
}

function onProgress(p: { status?: string; file?: string; loaded?: number; total?: number }) {
  if (p.status === "progress" && p.file && p.total) {
    files[p.file] = { loaded: p.loaded ?? 0, total: p.total }
    post({ type: "progress", files })
  }
}

async function build(device: "webgpu" | "wasm") {
  const asr = (await pipeline("automatic-speech-recognition", MODEL, {
    device,
    // fp32 on the GPU; 8-bit weights on the CPU path keep the download and the latency sane.
    dtype: device === "webgpu" ? "fp32" : "q8",
    progress_callback: onProgress,
  })) as unknown as Transcriber
  return { asr, device }
}

function load() {
  loading ??= (async () => {
    if (await hasWebGPU()) {
      try {
        return await build("webgpu")
      } catch {
        // Some adapters advertise WebGPU and then fail shader compilation; fall back rather than
        // leave the user with a dead microphone.
      }
    }
    return build("wasm")
  })()
  loading.catch(() => {
    loading = null
  })
  return loading
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: "load"; model?: string } | { type: "transcribe"; id: number; audio: Float32Array }
  try {
    if (msg.type === "load") {
      if (msg.model && !loading) MODEL = msg.model
      const { device } = await load()
      post({ type: "ready", device, model: MODEL })
      return
    }
    if (msg.type === "transcribe") {
      const { asr, device } = await load()
      const started = performance.now()
      const out = await asr(msg.audio, { chunk_length_s: 30, stride_length_s: 5 })
      const text = Array.isArray(out) ? out.map((o) => o.text).join(" ") : out.text
      post({ type: "result", id: msg.id, text, ms: Math.round(performance.now() - started), device })
    }
  } catch (err) {
    post({ type: "error", id: "id" in msg ? msg.id : undefined, message: err instanceof Error ? err.message : String(err) })
  }
}
