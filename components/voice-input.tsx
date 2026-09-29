"use client"

/**
 * Microphone input for /ask, transcribed by Whisper running in the browser.
 *
 * Click to start, click to stop (or it stops itself after MAX_SECONDS). The transcript is put into
 * the composer rather than sent: the user sees exactly what was heard before it becomes a governed
 * question, the same way a typed question is reviewed before Enter.
 *
 * The model starts downloading on the first click, while the user is still talking, so on a first
 * use the download overlaps the recording instead of following it.
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Mic, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import { aggregateProgress, normalizeTranscript, toMono } from "@/lib/voice"

const MAX_SECONDS = 20
const SAMPLE_RATE = 16000

type Phase = "idle" | "listening" | "transcribing"

export function VoiceInput({
  onTranscript,
  disabled,
}: {
  onTranscript: (text: string) => void
  disabled?: boolean
}) {
  const [phase, setPhase] = useState<Phase>("idle")
  const [seconds, setSeconds] = useState(0)
  const [modelProgress, setModelProgress] = useState<number | null>(null)
  const [modelReady, setModelReady] = useState(false)
  const [device, setDevice] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const workerRef = useRef<Worker | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const requestId = useRef(0)
  // The worker's handler is attached once; read the latest callback through a ref so a re-render
  // of the parent cannot leave it calling a stale closure.
  const onTranscriptRef = useRef(onTranscript)
  useEffect(() => {
    onTranscriptRef.current = onTranscript
  }, [onTranscript])
  // Decided after mount: the server has no navigator, and rendering the button there but not on a
  // browser without MediaRecorder (or vice versa) would be a hydration mismatch.
  const [supported, setSupported] = useState(false)
  useEffect(() => {
    setSupported(Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined")
  }, [])

  const worker = useCallback(() => {
    if (!workerRef.current) {
      const w = new Worker(new URL("../lib/whisper.worker.ts", import.meta.url), { type: "module" })
      w.onmessage = (e: MessageEvent) => {
        const m = e.data
        if (m.type === "progress") setModelProgress(aggregateProgress(m.files))
        if (m.type === "ready") {
          setModelReady(true)
          setModelProgress(null)
          setDevice(m.device)
        }
        if (m.type === "result" && m.id === requestId.current) {
          const text = normalizeTranscript(m.text ?? "")
          setPhase("idle")
          setDevice(m.device)
          if (text) {
            onTranscriptRef.current(text)
            setNote(`Transcribed on this device in ${(m.ms / 1000).toFixed(1)} s (${m.device === "webgpu" ? "GPU" : "CPU"}). Review, then press Enter.`)
          } else {
            setNote("No speech detected - try again, a little closer to the microphone.")
          }
        }
        if (m.type === "error") {
          setPhase("idle")
          setError(`Speech model error: ${m.message}`)
        }
      }
      w.postMessage({ type: "load", model: process.env.NEXT_PUBLIC_WHISPER_MODEL })
      workerRef.current = w
    }
    return workerRef.current
  }, [])

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (timerRef.current) clearInterval(timerRef.current)
    timerRef.current = null
  }

  useEffect(
    () => () => {
      stopTracks()
      workerRef.current?.terminate()
    },
    [],
  )

  const transcribe = useCallback(
    async (blob: Blob) => {
      setPhase("transcribing")
      try {
        const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i))
        await ctx.close()
        requestId.current += 1
        worker().postMessage({ type: "transcribe", id: requestId.current, audio: toMono(channels) })
      } catch (err) {
        setPhase("idle")
        setError(`Could not read the recording: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
    [worker],
  )

  const stop = useCallback(() => {
    recorderRef.current?.state === "recording" && recorderRef.current.stop()
  }, [])

  const start = useCallback(async () => {
    setError(null)
    setNote(null)
    worker() // begin the model download now, in parallel with speaking
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
      streamRef.current = stream
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data)
      rec.onstop = () => {
        stopTracks()
        void transcribe(new Blob(chunksRef.current, { type: rec.mimeType }))
      }
      recorderRef.current = rec
      rec.start()
      setSeconds(0)
      setPhase("listening")
      const began = Date.now()
      timerRef.current = setInterval(() => {
        const s = Math.floor((Date.now() - began) / 1000)
        setSeconds(s)
        if (s >= MAX_SECONDS) stop()
      }, 250)
    } catch (err) {
      stopTracks()
      const name = err instanceof DOMException ? err.name : ""
      setError(
        name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it in the browser's site settings to ask by voice."
          : name === "NotFoundError"
            ? "No microphone was found on this device."
            : `Could not start the microphone: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }, [stop, transcribe, worker])

  if (!supported) return null

  const listening = phase === "listening"
  const busy = phase === "transcribing"
  const label = listening ? "Stop recording" : busy ? "Transcribing" : "Ask by voice"

  return (
    <>
      <Button
        type="button"
        size="icon"
        variant={listening ? "destructive" : "outline"}
        title={label}
        aria-pressed={listening}
        disabled={disabled || busy}
        onClick={listening ? stop : start}
        className={listening ? "animate-pulse" : undefined}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
        ) : listening ? (
          <Square className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Mic className="h-4 w-4" aria-hidden />
        )}
        <span className="sr-only">{label}</span>
      </Button>
      <VoiceStatus
        phase={phase}
        seconds={seconds}
        modelProgress={modelProgress}
        modelReady={modelReady}
        device={device}
        note={note}
        error={error}
      />
    </>
  )
}

/** One status line, floated just above the composer so it never pushes the layout around. */
function VoiceStatus(p: {
  phase: Phase
  seconds: number
  modelProgress: number | null
  modelReady: boolean
  device: string | null
  note: string | null
  error: string | null
}) {
  let text: string | null = null
  if (p.error) text = p.error
  else if (p.phase === "listening")
    text = `Listening ${p.seconds}s / ${MAX_SECONDS}s - click the square to stop.${
      !p.modelReady && p.modelProgress !== null ? ` Speech model ${Math.round(p.modelProgress * 100)}% (first use only).` : ""
    }`
  else if (p.phase === "transcribing")
    text = p.modelReady
      ? "Transcribing on this device - audio is not uploaded anywhere."
      : `Loading the speech model${p.modelProgress !== null ? ` ${Math.round(p.modelProgress * 100)}%` : ""} - first use only, then cached by the browser.`
  else if (p.note) text = p.note
  if (!text) return null
  return (
    <p
      role={p.error ? "alert" : "status"}
      aria-live="polite"
      className={`pointer-events-none absolute -top-8 left-2 right-2 truncate rounded-md border border-border bg-card/95 px-2.5 py-1 text-[11px] shadow-sm backdrop-blur ${p.error ? "text-[var(--status-bad)]" : "text-muted-foreground"}`}
      title={text}
    >
      {text}
    </p>
  )
}
