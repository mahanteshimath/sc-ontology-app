/**
 * Supply chain vocabulary repair for speech transcripts.
 *
 * Whisper is a general model. It hears "OTIF" as "oh tiff", "PPV" as "p p v" and "SKU" as
 * "skew", and it sometimes emits non-speech tags such as "[BLANK_AUDIO]". Left alone, those
 * reach the resolver as unknown words and the question is refused as off-ontology - a voice
 * user would be told the metric does not exist when it was the transcript that was wrong.
 *
 * This is deliberately a small, explicit table rather than anything clever: every rewrite is
 * visible, testable, and limited to terms the ontology actually defines.
 */

const NON_SPEECH = /\[(?:blank_audio|music|silence|inaudible|noise)[^\]]*\]|\((?:music|silence|inaudible|noise|laughs?)[^)]*\)/gi

// Acronyms end in a lookahead, not \b: "O.T.D." ends in a period, and \b cannot match between a
// period and the space after it, so the dot would be left behind.
const END = String.raw`(?=\s|$|[,?!])`

const TERMS: ReadonlyArray<[RegExp, string]> = [
  [new RegExp(String.raw`\b(?:o\.?\s?t\.?\s?i\.?\s?f\.?|oh\s?tiff?|otiff?|o\s?tif)` + END, "gi"), "OTIF"],
  [new RegExp(String.raw`\b(?:o\.?\s?t\.?\s?d\.?|oh\s?tee\s?dee)` + END, "gi"), "OTD"],
  [new RegExp(String.raw`\b(?:p\.?\s?p\.?\s?v\.?|pee\s?pee\s?vee)` + END, "gi"), "PPV"],
  [new RegExp(String.raw`\b(?:s\.?\s?k\.?\s?u\.?s?|skews?)` + END, "gi"), "SKU"],
  [/\bD\.?\s?O\.?\s?I\b\.?/g, "days of inventory"],
  [/\bfill\s?-?\s?rates?\b/gi, "fill rate"],
  [/\bland(?:ed|id)?\s+costs?\b/gi, "landed cost"],
  [/\bon\s?-?\s?time\b/gi, "on-time"],
  [/\bin\s?-?\s?full\b/gi, "in full"],
  [new RegExp(String.raw`\bE\.?\s?U\.?` + END, "g"), "EU"],
  [new RegExp(String.raw`\bA\.?\s?P\.?\s?A\.?\s?C\.?` + END, "g"), "APAC"],
]

export function normalizeTranscript(raw: string): string {
  let text = raw.replace(NON_SPEECH, " ")
  for (const [pattern, replacement] of TERMS) text = text.replace(pattern, replacement)
  text = text.replace(/\s+/g, " ").trim()
  // Whisper often drops the question mark on a question; the resolver does not need it, but the
  // transcript reads as the question the user asked.
  if (/^(what|which|how|who|where|when|why|is|are|do|does|did|can|show|compare)\b/i.test(text) && !/[?.!]$/.test(text)) {
    text += "?"
  }
  return text
}

/** Downmix to mono. Whisper expects a single 16 kHz channel. */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const out = new Float32Array(channels[0].length)
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length
  return out
}

/** Fraction of the model downloaded, across every file the pipeline fetches. */
export function aggregateProgress(files: Record<string, { loaded: number; total: number }>): number {
  let loaded = 0
  let total = 0
  for (const f of Object.values(files)) {
    loaded += f.loaded
    total += f.total
  }
  return total > 0 ? Math.min(1, loaded / total) : 0
}
