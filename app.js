/**
 * VoiceType – Live Multilingual Speech to Text
 *
 * ON-DEVICE WHISPER ENGINE
 * ---------------------------------------------------------------------------
 * Speech recognition runs ENTIRELY inside the browser:
 *
 *   microphone ─► AudioContext (16 kHz mono PCM)
 *                      │
 *                      ├─ adaptive voice-activity detection (VAD)
 *                      │
 *                      └─ disjoint phrase chunk, cut on real silence
 *                               │
 *                               ▼
 *                   Web Worker + transformers.js
 *                   (open-source Whisper ONNX via WebGPU / WebAssembly)
 *                               │
 *                               ▼
 *                   text in the ORIGINAL writing system
 *                   (Malayalam / العربية / English)
 *
 * There is no server, no API key, no credits and no upload: the audio never
 * leaves the device. The only network activity is downloading the model files
 * once from the public Hugging Face CDN (then they are cached by the browser).
 *
 * WHY WORDS ARE NEVER DUPLICATED
 * ---------------------------------------------------------------------------
 * - Audio chunks are DISJOINT. A chunk is closed at a real pause, and the very
 *   next sample starts the following chunk, so no audio is ever fed twice.
 * - Every chunk carries a unique id and is committed EXACTLY ONCE (the
 *   `committedSegmentIds` guard drops any repeat).
 * - The transcript is append-only and is never rebuilt from a cumulative
 *   result list.
 * - There is NO text-based duplicate filter, so genuine repetitions that the
 *   speaker really said are preserved.
 *
 * CONFIRMED vs TEMPORARY
 * ---------------------------------------------------------------------------
 * Confirmed text lives in the editable textarea. Text that is still being
 * decoded is streamed into the separate `interimStream` panel and is never
 * mixed into the editor.
 */

// -------------------------------------------------------------
// 0. Configuration
// -------------------------------------------------------------

// Transformer.js build used for on-device inference (open source, MIT).
const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

// Open-source Whisper models, converted to ONNX and published on the
// Hugging Face Hub. Nothing here requires a key, an account or credits.
const MODEL_REGISTRY = {
  tiny:  { id: 'onnx-community/whisper-tiny',             label: 'Whisper Tiny' },
  base:  { id: 'onnx-community/whisper-base',             label: 'Whisper Base' },
  small: { id: 'onnx-community/whisper-small',            label: 'Whisper Small' },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo',   label: 'Whisper Large v3 Turbo' }
};

// Supported Languages
const LANG_CONFIG = {
  MALAYALAM: { code: 'ml-IN', short: 'ml', name: 'Malayalam', badge: 'Primary', script: 'മലയാളം' },
  ARABIC:    { code: 'ar-SA', short: 'ar', name: 'Arabic',    badge: 'Secondary', script: 'العربية' },
  ENGLISH:   { code: 'en-US', short: 'en', name: 'English',   badge: 'Tertiary', script: 'English' }
};

// Script ranges used to label the language of a decoded phrase.
const SCRIPT_PATTERNS = {
  malayalam: /[\u0D00-\u0D7F]/,
  arabic:    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  english:   /[a-zA-Z]/
};

// Audio capture + voice-activity-detection tuning.
// The speech gate is ADAPTIVE: it is derived from the measured room noise, so a
// quiet microphone still registers speech instead of staying silent.
const AUDIO = {
  SAMPLE_RATE: 16000,        // Whisper only accepts 16 kHz mono
  FRAME_MS: 20,              // VAD resolution
  PROCESSOR_BUFFER: 1024,    // ScriptProcessor window (~64 ms @16 kHz)
  CALIBRATION_MS: 600,       // listen to the room before latching the gate
  MIN_GATE: 0.0045,          // most sensitive gate we will ever use
  NOISE_MULTIPLIER: 2.6,     // gate = max(MIN_GATE, noiseFloor * this)
  MIN_SPEECH_MS: 160,        // voiced audio needed before a chunk opens
  SILENCE_CLOSE_MS: 700,     // pause length that closes a phrase
  TAIL_KEEP_MS: 180,         // silence kept at the end so no word is clipped
  MIN_CHUNK_MS: 500,         // ignore blips shorter than this
  MAX_CHUNK_MS: 14000,       // hard cap; Whisper's window is 30 s
  PREROLL_MS: 320            // audio kept before speech onset
};

const FRAME_SIZE = Math.round((AUDIO.SAMPLE_RATE * AUDIO.FRAME_MS) / 1000);
const PREROLL_FRAMES = Math.round(AUDIO.PREROLL_MS / AUDIO.FRAME_MS);
const CALIBRATION_FRAMES = Math.round(AUDIO.CALIBRATION_MS / AUDIO.FRAME_MS);

// RTL embedding marks so Arabic segments render right-to-left in a plain textarea
const RLE = '\u202B';
const PDF = '\u202C';

// -------------------------------------------------------------
// 0b. ASR worker source (runs off the main thread)
// -------------------------------------------------------------

const ASR_WORKER_SOURCE = [
  "'use strict';",
  "",
  "const CDN_URLS = [",
  "  " + JSON.stringify(TRANSFORMERS_CDN) + ",",
  "  " + JSON.stringify(TRANSFORMERS_CDN + "/dist/transformers.js"),
  "];",
  "",
  "let libPromise = null;",
  "",
  "function loadLibrary() {",
  "  if (!libPromise) {",
  "    libPromise = (async function () {",
  "      let lastError = null;",
  "      for (let i = 0; i < CDN_URLS.length; i++) {",
  "        try {",
  "          const mod = await import(CDN_URLS[i]);",
  "          if (mod && typeof mod.pipeline === 'function') return mod;",
  "          lastError = new Error('transformers.js export missing at ' + CDN_URLS[i]);",
  "        } catch (err) {",
  "          lastError = err;",
  "        }",
  "      }",
  "      throw lastError || new Error('Could not load the inference library.');",
  "    })();",
  "  }",
  "  return libPromise;",
  "}",
  "",
  "let transcriber = null;",
  "let chain = Promise.resolve();",
  "",
  "function emit(message) { self.postMessage(message); }",
  "function errText(err) { return (err && err.message) ? err.message : String(err); }",
  "",
  "// Whisper's own language-detection step. transformers.js does NOT do this for",
  "// us: when no language is given it silently falls back to English (see its",
  "// `_retrieve_init_tokens`). We therefore read the decoder logits that follow",
  "// <|startoftranscript|> ourselves and pick the most likely language token.",
  "// Candidates are limited to the three languages this app supports so the",
  "// output is always written in one of the expected native scripts.",
  "const TARGET_LANG_TOKENS = ['<|en|>', '<|ml|>', '<|ar|>'];",
  "",
  "async function detectLanguage(audio) {",
  "  const mod = await loadLibrary();",
  "  const model = transcriber && transcriber.model;",
  "  const gc = model && model.generation_config;",
  "  if (!gc || !gc.lang_to_id || gc.decoder_start_token_id == null) return null;",
  "",
  "  const candidates = [];",
  "  for (let i = 0; i < TARGET_LANG_TOKENS.length; i++) {",
  "    const token = TARGET_LANG_TOKENS[i];",
  "    const id = gc.lang_to_id[token];",
  "    if (typeof id === 'number') candidates.push({ code: token.slice(2, -2), id: id });",
  "  }",
  "  if (candidates.length === 0) return null;",
  "",
  "  // One encoder pass plus a single decoder step is all Whisper needs to",
  "  // decide the language.",
  "  const feature = await transcriber.processor(audio);",
  "  const start = gc.decoder_start_token_id;",
  "  const decoder_input_ids = new mod.Tensor('int64', BigInt64Array.from([BigInt(start)]), [1, 1]);",
  "  const out = await model.forward({",
  "    input_features: feature.input_features,",
  "    decoder_input_ids: decoder_input_ids",
  "  });",
  "",
  "  const logits = out && out.logits;",
  "  if (!logits || !logits.data || !logits.dims) return null;",
  "",
  "  const vocab = logits.dims[logits.dims.length - 1];",
  "  const base = logits.data.length - vocab;",
  "  let best = -Infinity;",
  "  let bestCode = null;",
  "  for (let i = 0; i < candidates.length; i++) {",
  "    const value = logits.data[base + candidates[i].id];",
  "    if (typeof value === 'number' && value > best) {",
  "      best = value;",
  "      bestCode = candidates[i].code;",
  "    }",
  "  }",
  "  return bestCode;",
  "}",
  "",
  "self.addEventListener('message', function (event) {",
  "  const data = event.data || {};",
  "  if (data.type === 'load') chain = chain.then(function () { return doLoad(data); }, function () { return doLoad(data); });",
  "  else if (data.type === 'transcribe') chain = chain.then(function () { return doTranscribe(data); }, function () { return doTranscribe(data); });",
  "});",
  "",
  "async function doLoad(data) {",
  "  try {",
  "    const mod = await loadLibrary();",
  "    const env = mod.env;",
  "    env.allowLocalModels = false;",
  "    env.useBrowserCache = true;",
  "",
  "    const order = data.device === 'wasm' ? ['wasm']",
  "                : data.device === 'webgpu' ? ['webgpu', 'wasm']",
  "                : ['webgpu', 'wasm'];",
  "",
  "    let lastError = null;",
  "    for (let i = 0; i < order.length; i++) {",
  "      const device = order[i];",
  "      // Whisper is very sensitive to encoder quantisation, so the encoder is",
  "      // kept at half precision on the GPU and 8-bit on the CPU.",
  "      const dtype = device === 'webgpu'",
  "        ? { encoder_model: 'fp16', decoder_model_merged: 'fp16' }",
  "        : 'q8';",
  "      try {",
  "        emit({ type: 'status', message: 'Loading weights on ' + device + '…' });",
  "        transcriber = await mod.pipeline('automatic-speech-recognition', data.model, {",
  "          device: device,",
  "          dtype: dtype,",
  "          progress_callback: function (p) { emit({ type: 'progress', payload: p }); }",
  "        });",
  "        lastError = null;",
  "        break;",
  "      } catch (err) {",
  "        lastError = err;",
  "        transcriber = null;",
  "        emit({ type: 'status', message: 'Backend ' + device + ' unavailable — trying the next one…' });",
  "      }",
  "    }",
  "",
  "    if (!transcriber) throw (lastError || new Error('The model could not be loaded.'));",
  "    emit({ type: 'loaded', device: transcriber.model && transcriber.model.device ? transcriber.model.device : order[0] });",
  "  } catch (err) {",
  "    emit({ type: 'error', scope: 'load', message: errText(err) });",
  "  }",
  "}",
  "",
  "async function doTranscribe(data) {",
  "  if (!transcriber) {",
  "    emit({ type: 'error', scope: 'transcribe', id: data.id, message: 'The model is not loaded yet.' });",
  "    return;",
  "  }",
  "",
  "  try {",
  "    // Manual language hint wins; otherwise let Whisper identify the language",
  "    // of this chunk so mixed-language speech is handled chunk by chunk.",
  "    let language = data.language || null;",
  "    if (!language) {",
  "      try {",
  "        language = await detectLanguage(data.audio);",
  "      } catch (detectError) {",
  "        language = null;",
  "      }",
  "    }",
  "",
  "    const options = { task: 'transcribe' };",
  "    if (language) options.language = language;",
  "",
  "    // Stream decoded tokens so the UI can show a temporary transcript.",
  "    try {",
  "      const mod = await loadLibrary();",
  "      if (mod.TextStreamer && transcriber.tokenizer) {",
  "        let acc = '';",
  "        options.streamer = new mod.TextStreamer(transcriber.tokenizer, {",
  "          skip_prompt: true,",
  "          skip_special_tokens: true,",
  "          callback_function: function (token) {",
  "            acc += token;",
  "            emit({ type: 'partial', id: data.id, text: acc });",
  "          }",
  "        });",
  "      }",
  "    } catch (streamError) {",
  "      delete options.streamer;",
  "    }",
  "",
  "    let output = null;",
  "    try {",
  "      output = await transcriber(data.audio, options);",
  "    } catch (firstError) {",
  "      if (!options.streamer) throw firstError;",
  "      // Retry once without streaming — a streamer problem must not lose audio.",
  "      delete options.streamer;",
  "      output = await transcriber(data.audio, options);",
  "    }",
  "",
  "    emit({ type: 'result', id: data.id, language: language, text: (output && output.text) ? output.text : '' });",
  "  } catch (err) {",
  "    emit({ type: 'error', scope: 'transcribe', id: data.id, message: errText(err) });",
  "  }",
  "}",
  ""
].join('\n');

// -------------------------------------------------------------
// 1. Application State
// -------------------------------------------------------------

let appState = 'idle';           // 'idle' | 'recording' | 'paused' | 'stopped'
let activeMode = 'auto';         // 'auto' | 'ml-IN' | 'ar-SA' | 'en-US'
let currentLangCode = 'ml-IN';
let detectedLang = LANG_CONFIG.MALAYALAM;

// Append-only transcript model (the editor is the single source of truth)
let finalTranscript = '';

// Segment store — each committed segment is recorded once, by unique id.
let segmentCounter = 0;
const committedSegmentIds = new Set();
const committedSegments = [];    // { id, lang, text }

// Bumped by "Clear Text" so in-flight decodes cannot repopulate a cleared editor.
let transcriptGeneration = 0;

// On-device engine state
let asrWorker = null;
let modelReady = false;
let modelLoading = false;
let pendingModelKey = null;
let loadedModelKey = null;
let loadedDeviceLabel = '';
let modelLoadResolve = null;
let pendingModelLoad = null;
const modelFileProgress = new Map();

// Transcription queue (one decode at a time, in capture order)
const transcriptionQueue = [];
let activeJob = null;
let partialText = '';
let segmentsDone = 0;
let segmentsQueued = 0;

// Microphone / audio graph
let micStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteNode = null;
let captureSampleRate = AUDIO.SAMPLE_RATE;

// VAD + chunk assembly
let noiseFloor = null;
let noiseSamples = [];
let prerollFrames = [];
let chunkFrames = [];
let speechActive = false;
let onsetMs = 0;
let silenceMs = 0;
let leftover = new Float32Array(0);
let lastLevelUiAt = 0;

// Timer State
let timerInterval = null;
let elapsedSeconds = 0;

// -------------------------------------------------------------
// 2. DOM Elements
// -------------------------------------------------------------

const textEditor = document.getElementById('textEditor');
const interimStream = document.getElementById('interimStream');
const interimText = document.getElementById('interimText');

const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resumeBtn = document.getElementById('resumeBtn');
const stopBtn = document.getElementById('stopBtn');

const detectedLangPill = document.getElementById('detectedLangPill');
const detectedLangDot = document.getElementById('detectedLangDot');
const detectedLangName = document.getElementById('detectedLangName');
const detectedLangBadge = document.getElementById('detectedLangBadge');
const langChips = document.querySelectorAll('.lang-chip');

const statusPill = document.getElementById('statusPill');
const statusDot = document.getElementById('statusDot');
const statusLabel = document.getElementById('statusLabel');
const timerDisplay = document.getElementById('timerDisplay');

const totalWordsEl = document.getElementById('totalWords');
const totalCharsEl = document.getElementById('totalChars');
const totalCharsNoSpaceEl = document.getElementById('totalCharsNoSpace');

const copyBtn = document.getElementById('copyBtn');
const copyBtnText = document.getElementById('copyBtnText');
const copyIcon = document.getElementById('copyIcon');
const downloadTxtBtn = document.getElementById('downloadTxtBtn');
const clearBtn = document.getElementById('clearBtn');
const selectAllBtn = document.getElementById('selectAllBtn');

const themeToggleBtn = document.getElementById('themeToggleBtn');
const themeIcon = document.getElementById('themeIcon');
const toast = document.getElementById('toast');
const toastMsg = document.getElementById('toastMsg');
const toastIcon = document.getElementById('toastIcon');
const unsupportedAlert = document.getElementById('unsupportedAlert');

// On-device engine card
const loadModelBtn = document.getElementById('loadModelBtn');
const loadModelBtnText = document.getElementById('loadModelBtnText');
const modelSelect = document.getElementById('modelSelect');
const deviceSelect = document.getElementById('deviceSelect');
const modelStatus = document.getElementById('modelStatus');
const modelPct = document.getElementById('modelPct');
const modelBar = document.getElementById('modelBar');

// Diagnostic elements
const dbgSupported = document.getElementById('dbgSupported');
const dbgMicPerm = document.getElementById('dbgMicPerm');
const dbgStarted = document.getElementById('dbgStarted');
const dbgAudio = document.getElementById('dbgAudio');
const dbgSpeech = document.getElementById('dbgSpeech');
const dbgLang = document.getElementById('dbgLang');
const dbgResult = document.getElementById('dbgResult');
const dbgError = document.getElementById('dbgError');

// -------------------------------------------------------------
// 3. Toast Notifications
// -------------------------------------------------------------

let toastTimeout = null;

function showToast(message, type = 'success') {
  if (!toast || !toastMsg || !toastIcon) return;
  if (toastTimeout) clearTimeout(toastTimeout);

  toastMsg.textContent = message;

  if (type === 'success') {
    toastIcon.setAttribute('data-lucide', 'check-circle');
    toastIcon.className = 'w-5 h-5 text-emerald-500';
  } else if (type === 'warning') {
    toastIcon.setAttribute('data-lucide', 'alert-circle');
    toastIcon.className = 'w-5 h-5 text-amber-500';
  } else if (type === 'error') {
    toastIcon.setAttribute('data-lucide', 'alert-triangle');
    toastIcon.className = 'w-5 h-5 text-rose-500';
  } else {
    toastIcon.setAttribute('data-lucide', 'info');
    toastIcon.className = 'w-5 h-5 text-indigo-500';
  }
  if (window.lucide) lucide.createIcons();

  toast.classList.add('show');
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2800);
}

// -------------------------------------------------------------
// 4. Interim / progress indicator (the TEMPORARY transcript)
// -------------------------------------------------------------

function showInterim(text) {
  if (!interimStream || !interimText) return;
  if (!text) return hideInterim();
  interimText.textContent = text;
  interimStream.classList.remove('hidden');
}

function hideInterim() {
  if (!interimStream || !interimText) return;
  interimText.textContent = '';
  interimStream.classList.add('hidden');
}

/** Repaint the temporary-transcript panel from the current engine state. */
function updateInterimState() {
  const pending = transcriptionQueue.length + (activeJob ? 1 : 0);

  if (partialText) {
    showInterim(partialText);
    return;
  }
  if (activeJob) {
    showInterim(pending > 1
      ? `⏳ Transcribing ${segmentsDone + 1} of ${segmentsDone + pending} segments…`
      : '⏳ Transcribing…');
    return;
  }
  if (speechActive) {
    showInterim('🎙 Capturing speech…');
    return;
  }
  if (appState === 'recording') {
    showInterim('🎙 Listening…');
    return;
  }
  hideInterim();
}

// -------------------------------------------------------------
// 5. Microphone Permission & Browser Support
// -------------------------------------------------------------

async function checkMicrophonePermission() {
  if (navigator.permissions && navigator.permissions.query) {
    try {
      const permissionStatus = await navigator.permissions.query({ name: 'microphone' });
      updateMicPermissionUI(permissionStatus.state);
      permissionStatus.onchange = () => updateMicPermissionUI(permissionStatus.state);
    } catch (err) {
      updateMicPermissionUI('Supported (Prompt on Start)');
    }
  } else {
    updateMicPermissionUI('Supported (Browser default)');
  }
}

function updateMicPermissionUI(state) {
  if (!dbgMicPerm) return;
  if (state === 'granted') {
    dbgMicPerm.textContent = 'Granted (Ready)';
    dbgMicPerm.className = 'font-bold text-emerald-400 text-xs mt-0.5';
  } else if (state === 'denied') {
    dbgMicPerm.textContent = 'Blocked / Denied';
    dbgMicPerm.className = 'font-bold text-rose-400 text-xs mt-0.5';
  } else {
    dbgMicPerm.textContent = 'Prompt (Click Start)';
    dbgMicPerm.className = 'font-bold text-amber-400 text-xs mt-0.5';
  }
}

function detectEngineSupport() {
  const hasWebAssembly = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
  const hasWorker = typeof Worker === 'function';
  const hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  const hasAudio = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  return {
    ok: hasWebAssembly && hasWorker && hasAudio,
    hasWebGPU: hasWebGPU
  };
}

// -------------------------------------------------------------
// 6. Language Helpers
// -------------------------------------------------------------

/**
 * Whisper returns the phrase in its own writing system, so the language can be
 * labelled reliably from the script that is actually present in the text.
 */
function classifyText(text) {
  if (!text || !text.trim()) return null;
  if (SCRIPT_PATTERNS.arabic.test(text)) return LANG_CONFIG.ARABIC;
  if (SCRIPT_PATTERNS.malayalam.test(text)) return LANG_CONFIG.MALAYALAM;
  if (SCRIPT_PATTERNS.english.test(text)) return LANG_CONFIG.ENGLISH;
  return null;
}

function updateLanguageUI(langObj) {
  if (!langObj) return;
  detectedLang = langObj;
  detectedLangName.textContent = langObj.name;
  detectedLangBadge.textContent = langObj.badge;

  if (dbgLang) dbgLang.textContent = `${langObj.code} (${langObj.name})`;

  if (langObj.code === LANG_CONFIG.MALAYALAM.code) {
    detectedLangPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-300 shadow-sm transition-all';
    detectedLangDot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
    detectedLangBadge.className = 'text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 ml-0.5';
  } else if (langObj.code === LANG_CONFIG.ARABIC.code) {
    detectedLangPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-300 shadow-sm transition-all';
    detectedLangDot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
    detectedLangBadge.className = 'text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/60 text-amber-700 dark:text-amber-300 ml-0.5';
  } else {
    detectedLangPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-semibold bg-sky-50 dark:bg-sky-950/40 border border-sky-200 dark:border-sky-800/60 text-sky-800 dark:text-sky-300 shadow-sm transition-all';
    detectedLangDot.className = 'w-2 h-2 rounded-full bg-sky-500 animate-pulse';
    detectedLangBadge.className = 'text-[10px] uppercase font-mono px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-900/60 text-sky-700 dark:text-sky-300 ml-0.5';
  }
}

// -------------------------------------------------------------
// 7. Segment Store — commit each decoded segment EXACTLY ONCE
// -------------------------------------------------------------

function makeSegmentId(prefix) {
  segmentCounter += 1;
  return `${prefix}-${segmentCounter}-${Date.now()}`;
}

/** Append text to the transcript with correct spacing / sentence breaks. */
function appendToTranscript(text) {
  const clean = text.trim();
  if (!clean) return;

  let out = finalTranscript;

  if (out.length > 0 && !/\s$/.test(out)) {
    // Add a space so words never fuse; add a sentence break after terminal
    // punctuation so distinct sentences stay readable.
    out += /[.!?।؟]$/.test(out.trim()) ? '\n' : ' ';
  }

  finalTranscript = out + clean;
  textEditor.value = finalTranscript;
  updateCounters();
  textEditor.scrollTop = textEditor.scrollHeight;
}

/**
 * Commit a decoded segment once. Duplicate ids are ignored, so a segment can
 * never be written to the transcript twice.
 * NOTE: no text-based filtering — intentional repetitions are preserved.
 */
function commitSegment(langCode, text, providedId) {
  const id = providedId || makeSegmentId('seg');
  if (committedSegmentIds.has(id)) return false;
  if (!text || !text.trim()) return false;

  const langObj = Object.values(LANG_CONFIG).find(l => l.code === langCode) || detectedLang;
  const rendered = langObj.code === LANG_CONFIG.ARABIC.code ? RLE + text.trim() + PDF : text.trim();

  committedSegmentIds.add(id);
  committedSegments.push({ id, lang: langObj.code, text: text.trim() });

  appendToTranscript(rendered);

  // Language indicator follows the language actually used for this segment.
  if (langObj.code !== detectedLang.code) updateLanguageUI(langObj);

  recordSegmentDiagnostic();
  return true;
}

function recordSegmentDiagnostic() {
  if (!dbgResult) return;
  const last = committedSegments[committedSegments.length - 1];
  dbgResult.textContent = `Segments: ${committedSegments.length} | "${(last ? last.text : '').slice(-35)}"`;
  dbgResult.className = 'font-semibold text-emerald-400 text-xs mt-0.5 truncate';
}

function clearSegments() {
  segmentCounter = 0;
  committedSegmentIds.clear();
  committedSegments.length = 0;
}

// -------------------------------------------------------------
// 8. Diagnostics helpers
// -------------------------------------------------------------

function setErrorDiagnostic(text) {
  if (!dbgError) return;
  dbgError.textContent = text;
  dbgError.className = text === 'None'
    ? 'font-semibold text-slate-400 text-xs mt-0.5 truncate'
    : 'font-semibold text-rose-400 text-xs mt-0.5 truncate';
}

/** Live mic-level readout so "it can't hear me" is diagnosable at a glance. */
function updateLevelDiagnostic(rms, gate, calibrating) {
  if (!dbgSpeech) return;
  const now = Date.now();
  if (now - lastLevelUiAt < 250) return;
  lastLevelUiAt = now;

  if (rms > gate) {
    dbgSpeech.textContent = calibrating
      ? 'Calibrating…'
      : `Speech Detected (${rms.toFixed(3)} > ${gate.toFixed(3)})`;
    dbgSpeech.className = 'font-bold text-emerald-400 text-xs mt-0.5';
  } else {
    dbgSpeech.textContent = calibrating
      ? `Calibrating… level ${rms.toFixed(3)}`
      : `Listening — level ${rms.toFixed(3)} / gate ${gate.toFixed(3)}`;
    dbgSpeech.className = 'font-bold text-slate-400 text-xs mt-0.5';
  }
}

// -------------------------------------------------------------
// 9. Model loading (download progress)
// -------------------------------------------------------------

function setModelProgress(percent, statusText, isError) {
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  if (modelBar) modelBar.style.width = pct + '%';
  if (modelPct) modelPct.textContent = pct + '%';
  if (modelStatus) {
    modelStatus.textContent = statusText;
    modelStatus.className = isError
      ? 'text-rose-500 dark:text-rose-400'
      : 'text-slate-500 dark:text-slate-400';
  }
}

function ensureWorker() {
  if (asrWorker) return asrWorker;

  const blob = new Blob([ASR_WORKER_SOURCE], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  asrWorker = new Worker(url, { type: 'module' });
  asrWorker.onmessage = handleWorkerMessage;
  asrWorker.onerror = (event) => {
    setErrorDiagnostic('Worker error: ' + (event.message || 'unknown'));
    setModelProgress(0, 'Inference worker failed to start.', true);
    modelLoading = false;
    modelReady = false;
    loadModelBtn.disabled = false;
    loadModelBtnText.textContent = 'Load Model';
    resolveModelLoad(false);
  };
  return asrWorker;
}

function onModelFileProgress(payload) {
  if (!payload) return;

  if (payload.status === 'ready') return;

  if (payload.file) {
    const current = modelFileProgress.get(payload.file) || { loaded: 0, total: 0 };
    if (payload.status === 'initiate') {
      modelFileProgress.set(payload.file, { loaded: 0, total: payload.total || 0 });
    } else if (payload.status === 'done') {
      modelFileProgress.set(payload.file, { loaded: current.total || current.loaded, total: current.total || current.loaded });
    } else {
      modelFileProgress.set(payload.file, {
        loaded: typeof payload.loaded === 'number' ? payload.loaded : current.loaded,
        total: typeof payload.total === 'number' ? payload.total : current.total
      });
    }
  }

  let loaded = 0;
  let total = 0;
  modelFileProgress.forEach((entry) => { loaded += entry.loaded; total += entry.total; });

  if (total > 0) {
    const mb = (value) => (value / 1048576).toFixed(1);
    setModelProgress((loaded / total) * 100, `Downloading ${mb(loaded)} MB / ${mb(total)} MB…`);
  }
}

function loadModel(force) {
  if (pendingModelLoad) return pendingModelLoad;

  const key = modelSelect ? modelSelect.value : 'base';
  const spec = MODEL_REGISTRY[key];
  if (!spec) return Promise.resolve(false);
  if (modelReady && loadedModelKey === key && !force) return Promise.resolve(true);

  modelReady = false;
  loadedModelKey = null;
  modelFileProgress.clear();
  setModelProgress(0, `Preparing ${spec.label}…`);
  loadModelBtn.disabled = true;
  loadModelBtnText.textContent = 'Loading…';

  let workerRef;
  try {
    workerRef = ensureWorker();
  } catch (err) {
    loadModelBtn.disabled = false;
    loadModelBtnText.textContent = 'Load Model';
    setModelProgress(0, 'This browser cannot start the inference worker.', true);
    showToast('This browser cannot run the on-device model. Use Chrome or Edge.', 'error');
    return Promise.resolve(false);
  }

  modelLoading = true;
  pendingModelKey = key;

  return pendingModelLoad = new Promise((resolve) => {
    modelLoadResolve = resolve;
    workerRef.postMessage({
      type: 'load',
      model: spec.id,
      device: deviceSelect ? deviceSelect.value : 'auto'
    });
  });
}

function handleWorkerMessage(event) {
  const msg = event.data || {};

  if (msg.type === 'status') {
    setModelProgress(currentPercent(), msg.message);
    return;
  }

  if (msg.type === 'progress') {
    if (modelLoading) onModelFileProgress(msg.payload);
    return;
  }

  if (msg.type === 'loaded') {
    modelReady = true;
    modelLoading = false;
    loadedModelKey = pendingModelKey;
    loadedDeviceLabel = msg.device === 'webgpu' ? 'WebGPU (GPU)' : 'WebAssembly (CPU)';
    const spec = MODEL_REGISTRY[loadedModelKey] || { label: 'Whisper' };
    loadModelBtn.disabled = false;
    loadModelBtnText.textContent = 'Model Ready';
    setModelProgress(100, `${spec.label} ready · ${loadedDeviceLabel}`);
    showToast(`${spec.label} loaded on ${loadedDeviceLabel}. Press Start and speak.`, 'success');
    resolveModelLoad(true);
    pumpQueue();
    return;
  }

  if (msg.type === 'partial') {
    if (activeJob && msg.id === activeJob.id) {
      partialText = msg.text;
      updateInterimState();
    }
    return;
  }

  if (msg.type === 'result') {
    onTranscribeResult(msg);
    return;
  }

  if (msg.type === 'error') {
    if (msg.scope === 'load') {
      modelLoading = false;
      modelReady = false;
      loadModelBtn.disabled = false;
      loadModelBtnText.textContent = 'Load Model';
      setModelProgress(0, 'Model load failed.', true);
      setErrorDiagnostic('Error: ' + msg.message);
      showToast('Could not load the model: ' + msg.message, 'error');
      resolveModelLoad(false);
    } else {
      onTranscribeError(msg);
    }
  }
}

function currentPercent() {
  const raw = modelPct ? parseInt(String(modelPct.textContent).replace('%', ''), 10) : 0;
  return Number.isFinite(raw) ? raw : 0;
}

function resolveModelLoad(value) {
  pendingModelLoad = null;
  if (modelLoadResolve) {
    modelLoadResolve(value);
    modelLoadResolve = null;
  }
}

// -------------------------------------------------------------
// 10. Transcription queue (one decode at a time, in capture order)
// -------------------------------------------------------------

function enqueueChunk(samples, durationMs) {
  const id = makeSegmentId('chunk');
  segmentsQueued += 1;
  transcriptionQueue.push({ id, samples, durationMs, generation: transcriptGeneration });
  updateInterimState();
  pumpQueue();
}

function pumpQueue() {
  if (activeJob) return;
  if (transcriptionQueue.length === 0) { updateInterimState(); return; }
  if (!modelReady || !asrWorker) return;

  activeJob = transcriptionQueue.shift();
  partialText = '';
  updateInterimState();

  try {
    asrWorker.postMessage({
      type: 'transcribe',
      id: activeJob.id,
      audio: activeJob.samples,
      language: activeMode === 'auto' ? null : activeMode.split('-')[0]
    }, [activeJob.samples.buffer]);
  } catch (err) {
    setErrorDiagnostic('Error: ' + (err && err.message ? err.message : 'post failed'));
    activeJob = null;
    pumpQueue();
  }
}

function onTranscribeResult(msg) {
  const job = activeJob;
  activeJob = null;
  partialText = '';

  if (job && msg.id === job.id) {
    segmentsDone += 1;
    if (job.generation === transcriptGeneration && msg.text) {
      // The script actually present in the text is checked first; the language
      // Whisper detected is used when the text alone is ambiguous.
      const reported = msg.language
        ? Object.values(LANG_CONFIG).find((l) => l.short === msg.language)
        : null;
      const langObj = classifyText(msg.text) || reported || detectedLang;
      commitSegment(langObj.code, msg.text, job.id);
    }
  }

  updateInterimState();
  pumpQueue();
}

function onTranscribeError(msg) {
  activeJob = null;
  partialText = '';
  segmentsDone += 1;
  setErrorDiagnostic('Error: ' + msg.message);
  showToast('A segment could not be transcribed. Continuing.', 'warning');
  updateInterimState();
  pumpQueue();
}

// -------------------------------------------------------------
// 11. Audio capture — 16 kHz mono PCM + adaptive VAD chunking
// -------------------------------------------------------------

function resetVadState() {
  noiseFloor = null;
  noiseSamples = [];
  prerollFrames = [];
  chunkFrames = [];
  speechActive = false;
  onsetMs = 0;
  silenceMs = 0;
  leftover = new Float32Array(0);
}

function resampleLinear(input, inRate, outRate) {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = i0 + 1 < input.length ? i0 + 1 : input.length - 1;
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

function onAudioProcess(event) {
  if (appState !== 'recording') return;

  const channel = event.inputBuffer.getChannelData(0);
  const samples = captureSampleRate === AUDIO.SAMPLE_RATE
    ? channel
    : resampleLinear(channel, captureSampleRate, AUDIO.SAMPLE_RATE);

  const merged = new Float32Array(leftover.length + samples.length);
  merged.set(leftover, 0);
  merged.set(samples, leftover.length);

  let offset = 0;
  while (merged.length - offset >= FRAME_SIZE) {
    processFrame(merged.subarray(offset, offset + FRAME_SIZE));
    offset += FRAME_SIZE;
  }

  leftover = merged.slice(offset);
}

function processFrame(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i];
    sum += v * v;
  }
  const rms = Math.sqrt(sum / frame.length);

  // Phase 1 — measure the room so the gate matches this microphone.
  if (noiseFloor === null) {
    noiseSamples.push(rms);
    if (noiseSamples.length >= CALIBRATION_FRAMES) {
      let total = 0;
      for (let i = 0; i < noiseSamples.length; i++) total += noiseSamples[i];
      noiseFloor = total / noiseSamples.length;
      noiseSamples = [];
    }
  }

  const gate = noiseFloor === null
    ? AUDIO.MIN_GATE
    : Math.max(AUDIO.MIN_GATE, noiseFloor * AUDIO.NOISE_MULTIPLIER);

  const voiced = rms > gate;
  updateLevelDiagnostic(rms, gate, noiseFloor === null);

  // Phase 2 — build a chunk only around actual speech.
  if (!speechActive) {
    prerollFrames.push(frame.slice());
    if (prerollFrames.length > PREROLL_FRAMES) prerollFrames.shift();

    onsetMs = voiced ? onsetMs + AUDIO.FRAME_MS : 0;

    if (onsetMs >= AUDIO.MIN_SPEECH_MS) {
      speechActive = true;
      chunkFrames = prerollFrames;   // keeps the audio captured just before onset
      prerollFrames = [];
      silenceMs = 0;
      updateInterimState();
    }
    return;
  }

  chunkFrames.push(frame.slice());
  silenceMs = voiced ? 0 : silenceMs + AUDIO.FRAME_MS;

  const chunkMs = chunkFrames.length * AUDIO.FRAME_MS;
  const closedOnPause = silenceMs >= AUDIO.SILENCE_CLOSE_MS && chunkMs >= AUDIO.MIN_CHUNK_MS;

  if (closedOnPause || chunkMs >= AUDIO.MAX_CHUNK_MS) closeChunk();
}

/**
 * Turn the frames collected so far into one DISJOINT chunk of 16 kHz mono
 * audio. Trailing silence is trimmed but a little is kept so the final word is
 * never clipped. Silence-only audio is discarded rather than sent to Whisper
 * (Whisper invents words when it is fed pure silence).
 */
function closeChunk() {
  const frames = chunkFrames;
  const trailingSilence = silenceMs;

  chunkFrames = [];
  speechActive = false;
  onsetMs = 0;
  silenceMs = 0;

  if (frames.length === 0) { updateInterimState(); return; }

  const frameLength = frames[0].length;
  let endFrame = frames.length;
  if (trailingSilence > AUDIO.TAIL_KEEP_MS) {
    const drop = Math.floor((trailingSilence - AUDIO.TAIL_KEEP_MS) / AUDIO.FRAME_MS);
    endFrame = Math.max(1, endFrame - drop);
  }

  const totalSamples = endFrame * frameLength;
  const durationMs = (totalSamples / AUDIO.SAMPLE_RATE) * 1000;
  if (durationMs < AUDIO.MIN_CHUNK_MS) { updateInterimState(); return; }

  const flat = new Float32Array(totalSamples);
  for (let i = 0; i < endFrame; i++) flat.set(frames[i], i * frameLength);

  enqueueChunk(flat, durationMs);
  updateInterimState();
}

async function startCapture() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }
    });
  } catch (err) {
    updateMicPermissionUI('denied');
    showToast('Microphone access blocked. Allow it in the address bar and try again.', 'error');
    return false;
  }

  updateMicPermissionUI('granted');

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  try {
    audioContext = new AudioCtx({ sampleRate: AUDIO.SAMPLE_RATE });
  } catch (err) {
    audioContext = new AudioCtx();
  }
  if (audioContext.state === 'suspended') {
    try { await audioContext.resume(); } catch (err) { /* resumed by the gesture */ }
  }
  captureSampleRate = audioContext.sampleRate || AUDIO.SAMPLE_RATE;

  sourceNode = audioContext.createMediaStreamSource(micStream);
  processorNode = audioContext.createScriptProcessor(AUDIO.PROCESSOR_BUFFER, 1, 1);
  processorNode.onaudioprocess = onAudioProcess;
  sourceNode.connect(processorNode);

  // ScriptProcessor only runs when connected to the output; the gain node keeps
  // it silent so nothing is played back through the speakers.
  muteNode = audioContext.createGain();
  muteNode.gain.value = 0;
  processorNode.connect(muteNode);
  muteNode.connect(audioContext.destination);

  resetVadState();

  if (dbgAudio) { dbgAudio.textContent = `Yes (${Math.round(captureSampleRate / 1000)} kHz PCM → 16 kHz)`; dbgAudio.className = 'font-bold text-emerald-400 text-xs mt-0.5'; }
  if (dbgStarted) { dbgStarted.textContent = 'Capturing…'; dbgStarted.className = 'font-bold text-emerald-400 text-xs mt-0.5'; }
  return true;
}

function stopCapture() {
  if (processorNode) {
    processorNode.onaudioprocess = null;
    try { processorNode.disconnect(); } catch (err) { /* noop */ }
    processorNode = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch (err) { /* noop */ }
    sourceNode = null;
  }
  if (muteNode) {
    try { muteNode.disconnect(); } catch (err) { /* noop */ }
    muteNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    try { audioContext.close(); } catch (err) { /* noop */ }
  }
  audioContext = null;

  resetVadState();

  if (dbgAudio) { dbgAudio.textContent = 'No'; dbgAudio.className = 'font-bold text-slate-400 text-xs mt-0.5'; }
  if (dbgStarted) { dbgStarted.textContent = 'Idle'; dbgStarted.className = 'font-bold text-slate-400 text-xs mt-0.5'; }
}

/** Close whatever phrase is in progress so a pause never loses speech. */
function flushPendingAudio() {
  if (speechActive) closeChunk();
}

// -------------------------------------------------------------
// 12. Session Controls
// -------------------------------------------------------------

async function ensureModelForSession() {
  const key = modelSelect ? modelSelect.value : 'base';
  if (modelReady && loadedModelKey === key) return true;

  if (modelLoading) {
    showToast('The model is still loading — one moment…', 'warning');
    return false;
  }

  showToast('Downloading the on-device Whisper model…', 'info');
  return await loadModel();
}

async function startSession() {
  setErrorDiagnostic('None');
  finalTranscript = textEditor.value;

  const support = detectEngineSupport();
  if (!support.ok) {
    if (unsupportedAlert) unsupportedAlert.classList.remove('hidden');
    updateStatus('unsupported');
    showToast('This browser cannot run the on-device engine. Use Chrome or Edge.', 'error');
    return;
  }

  const ready = await ensureModelForSession();
  if (!ready) return;

  const captured = await startCapture();
  if (!captured) return;

  appState = 'recording';
  updateControls();
  updateStatus('listening');
  startTimer();
  updateInterimState();
  showToast('Listening on your device — Whisper detects the language automatically.', 'info');
}

function pauseSession() {
  if (appState !== 'recording') return;

  flushPendingAudio();
  stopCapture();

  appState = 'paused';
  stopTimer();
  updateStatus('paused');
  updateControls();
  updateInterimState();
  showToast('Paused. Your text is preserved.', 'info');
}

async function resumeSession() {
  if (appState !== 'paused') return;

  finalTranscript = textEditor.value;

  const captured = await startCapture();
  if (!captured) return;

  appState = 'recording';
  updateControls();
  updateStatus('listening');
  startTimer();
  updateInterimState();
  showToast('Resumed — listening.', 'info');
}

function stopSession() {
  if (appState === 'idle' || appState === 'stopped') return;

  flushPendingAudio();
  stopCapture();

  appState = 'stopped';
  finalTranscript = textEditor.value;
  updateCounters();
  stopTimer();
  updateStatus('stopped');
  updateControls();
  updateInterimState();
  showToast('Recording stopped. Remaining audio is still being transcribed.', 'info');
}

// -------------------------------------------------------------
// 13. Controls & Status
// -------------------------------------------------------------

function updateControls() {
  if (appState === 'recording') {
    startBtn.disabled = true;  pauseBtn.disabled = false;
    resumeBtn.disabled = true; stopBtn.disabled = false;
  } else if (appState === 'paused') {
    startBtn.disabled = true;  pauseBtn.disabled = true;
    resumeBtn.disabled = false; stopBtn.disabled = false;
  } else {
    startBtn.disabled = false; pauseBtn.disabled = true;
    resumeBtn.disabled = true;  stopBtn.disabled = true;
  }

  // The backend/model cannot be swapped while audio is being captured.
  const lockEngineChoice = appState === 'recording';
  if (modelSelect) modelSelect.disabled = lockEngineChoice;
  if (deviceSelect) deviceSelect.disabled = lockEngineChoice;
  if (loadModelBtn) loadModelBtn.disabled = lockEngineChoice || modelLoading;
}

function updateStatus(status) {
  statusDot.className = 'w-2.5 h-2.5 rounded-full transition-all';

  if (status === 'listening') {
    statusLabel.textContent = 'Listening';
    statusDot.classList.add('recording-dot');
    statusPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200 dark:border-rose-900/50 shadow-sm';
  } else if (status === 'paused') {
    statusLabel.textContent = 'Paused';
    statusDot.classList.add('bg-amber-500');
    statusPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-900/50';
  } else if (status === 'stopped') {
    statusLabel.textContent = 'Stopped';
    statusDot.classList.add('bg-slate-400');
    statusPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700';
  } else if (status === 'unsupported') {
    statusLabel.textContent = 'Unsupported';
    statusDot.classList.add('bg-rose-500');
    statusPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-rose-100 text-rose-800 border border-rose-300';
  } else {
    statusLabel.textContent = 'Ready';
    statusDot.classList.add('bg-emerald-500');
    statusPill.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700';
  }
}

// -------------------------------------------------------------
// 14. Language Chips (Auto detect + optional manual hint)
// -------------------------------------------------------------

langChips.forEach(chip => {
  chip.addEventListener('click', () => {
    langChips.forEach(c => c.classList.remove('active-chip'));
    chip.classList.add('active-chip');

    const mode = chip.dataset.mode;
    activeMode = mode;

    if (mode === 'auto') {
      currentLangCode = LANG_CONFIG.MALAYALAM.code;
      updateLanguageUI(LANG_CONFIG.MALAYALAM);
      showToast('Auto-detect enabled — Whisper identifies the language from your voice.', 'info');
    } else {
      currentLangCode = mode;
      const langObj = Object.values(LANG_CONFIG).find(l => l.code === mode) || LANG_CONFIG.MALAYALAM;
      updateLanguageUI(langObj);
      showToast(`Language hint set to ${langObj.name}.`, 'info');
    }
  });
});

// -------------------------------------------------------------
// 15. Timer (MM:SS)
// -------------------------------------------------------------

function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => { elapsedSeconds++; renderTimer(); }, 1000);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

function resetTimer() { stopTimer(); elapsedSeconds = 0; renderTimer(); }

function renderTimer() {
  const m = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const s = String(elapsedSeconds % 60).padStart(2, '0');
  timerDisplay.textContent = `${m}:${s}`;
}

// -------------------------------------------------------------
// 16. Word & Character Counters
// -------------------------------------------------------------

function updateCounters() {
  const text = textEditor.value;
  const words = text.trim().length > 0 ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  totalWordsEl.textContent = words.toLocaleString();
  totalCharsEl.textContent = text.length.toLocaleString();
  totalCharsNoSpaceEl.textContent = text.replace(/\s/g, '').length.toLocaleString();
}

// Manual edits stay authoritative and are never overwritten mid-recording.
textEditor.addEventListener('input', () => {
  finalTranscript = textEditor.value;
  updateCounters();
});

// -------------------------------------------------------------
// 17. On-Device Engine Card listeners
// -------------------------------------------------------------

if (loadModelBtn) {
  loadModelBtn.addEventListener('click', async () => {
    if (modelReady && loadedModelKey === (modelSelect ? modelSelect.value : '')) {
      showToast('That model is already loaded.', 'info');
      return;
    }
    await loadModel();
  });
}

if (modelSelect) {
  modelSelect.addEventListener('change', () => {
    if (appState === 'recording') return;
    const key = modelSelect.value;
    if (key === loadedModelKey && modelReady) return;

    // A different model means the queued audio can no longer be decoded.
    transcriptionQueue.length = 0;
    segmentsQueued = segmentsDone;
    modelReady = false;
    loadedModelKey = null;
    loadModelBtnText.textContent = 'Load Model';
    setModelProgress(0, 'Model changed — click Load Model.');
    updateInterimState();
  });
}

if (deviceSelect) {
  deviceSelect.addEventListener('change', () => {
    if (appState === 'recording') return;
    const spec = MODEL_REGISTRY[modelSelect ? modelSelect.value : 'base'];
    modelReady = false;
    loadedModelKey = null;
    loadModelBtnText.textContent = 'Load Model';
    setModelProgress(0, `Backend changed — reload ${spec ? spec.label : 'the model'}.`);
  });
}

// -------------------------------------------------------------
// 18. Actions (Copy, Download TXT, Clear, Select All)
// -------------------------------------------------------------

copyBtn.addEventListener('click', async () => {
  const text = textEditor.value.trim();
  if (!text) { showToast('There is no text to copy!', 'warning'); return; }

  try {
    await navigator.clipboard.writeText(text);
    copyBtnText.textContent = 'Copied!';
    copyIcon.setAttribute('data-lucide', 'check');
    copyBtn.classList.add('bg-emerald-50', 'text-emerald-700', 'border-emerald-300', 'dark:bg-emerald-950/50', 'dark:text-emerald-300');
    if (window.lucide) lucide.createIcons();
    showToast('Text copied to clipboard!', 'success');

    setTimeout(() => {
      copyBtnText.textContent = 'Copy Text';
      copyIcon.setAttribute('data-lucide', 'copy');
      copyBtn.classList.remove('bg-emerald-50', 'text-emerald-700', 'border-emerald-300', 'dark:bg-emerald-950/50', 'dark:text-emerald-300');
      if (window.lucide) lucide.createIcons();
    }, 2000);
  } catch (err) {
    console.error('Clipboard copy failed:', err);
    showToast('Failed to copy text.', 'error');
  }
});

downloadTxtBtn.addEventListener('click', () => {
  const text = textEditor.value.trim();
  if (!text) { showToast('Editor is empty. Nothing to download!', 'warning'); return; }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  const filename = `VoiceType_Transcript_${dateStr}_${timeStr}.txt`;

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const downloadUrl = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(downloadUrl);

  showToast('Transcript downloaded as .txt file!', 'success');
});

clearBtn.addEventListener('click', () => {
  if (!textEditor.value.trim()) return;

  if (confirm('Are you sure you want to clear the entire text editor?')) {
    // Invalidate anything still decoding so it cannot repopulate the editor.
    transcriptGeneration += 1;
    transcriptionQueue.length = 0;
    activeJob = null;
    partialText = '';
    segmentsDone = 0;
    segmentsQueued = 0;

    textEditor.value = '';
    finalTranscript = '';
    clearSegments();
    hideInterim();
    resetTimer();
    updateCounters();
    if (dbgResult) dbgResult.textContent = '0 segments transcribed';
    showToast('Text editor cleared.', 'info');
  }
});

selectAllBtn.addEventListener('click', () => {
  if (!textEditor.value.trim()) { showToast('Text editor is empty.', 'info'); return; }
  textEditor.focus();
  textEditor.select();
  showToast('All text selected.', 'info');
});

// -------------------------------------------------------------
// 19. Button Listeners
// -------------------------------------------------------------

startBtn.addEventListener('click', () => { resetTimer(); startSession(); });
pauseBtn.addEventListener('click', () => { pauseSession(); });
resumeBtn.addEventListener('click', () => { resumeSession(); });
stopBtn.addEventListener('click', () => { stopSession(); });

// -------------------------------------------------------------
// 20. Keyboard Shortcuts
// -------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (appState === 'recording') pauseSession();
    else if (appState === 'paused') resumeSession();
    else { resetTimer(); startSession(); }
  }

  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    e.preventDefault();
    copyBtn.click();
  }
});

// Release the microphone if the page is closed while recording.
window.addEventListener('beforeunload', () => { if (micStream) stopCapture(); });

// -------------------------------------------------------------
// 21. Light / Dark Theme
// -------------------------------------------------------------

function applyTheme(isDark) {
  if (isDark) {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
    themeIcon.setAttribute('data-lucide', 'sun');
    localStorage.setItem('voicetype_theme', 'dark');
  } else {
    document.documentElement.classList.remove('dark');
    document.documentElement.classList.add('light');
    themeIcon.setAttribute('data-lucide', 'moon');
    localStorage.setItem('voicetype_theme', 'light');
  }
  if (window.lucide) lucide.createIcons();
}

themeToggleBtn.addEventListener('click', () => {
  applyTheme(!document.documentElement.classList.contains('dark'));
});

// -------------------------------------------------------------
// 22. Bootstrap
// -------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  applyTheme((localStorage.getItem('voicetype_theme') || 'light') === 'dark');

  checkMicrophonePermission();
  updateControls();
  updateStatus('ready');
  updateCounters();
  updateLanguageUI(LANG_CONFIG.MALAYALAM);
  setModelProgress(0, 'Model not loaded yet.');

  const support = detectEngineSupport();
  if (!support.ok) {
    if (unsupportedAlert) unsupportedAlert.classList.remove('hidden');
    updateStatus('unsupported');
    startBtn.disabled = true;
    if (loadModelBtn) loadModelBtn.disabled = true;
    if (dbgSupported) {
      dbgSupported.textContent = 'No (Unsupported)';
      dbgSupported.className = 'font-bold text-rose-400 text-xs mt-0.5';
    }
    setModelProgress(0, 'WebAssembly worker unavailable in this browser.', true);
    return;
  }

  if (dbgSupported) {
    dbgSupported.textContent = support.hasWebGPU
      ? 'Yes (On-device · WebGPU available)'
      : 'Yes (On-device · WebAssembly)';
    dbgSupported.className = 'font-bold text-emerald-400 text-xs mt-0.5';
  }

  showToast('On-device engine ready. Press Load Model, then Start.', 'info');
});
