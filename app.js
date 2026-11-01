/**
 * VoiceType – Live Speech to Text
 * On-Device Whisper Multilingual Transcription Engine
 * 
 * Features:
 * - 100% On-Device local Whisper model via Transformers.js (v3)
 * - Zero API keys, zero paid services, no audio data leaves your device
 * - WebGPU Hardware Acceleration on supported Desktop/Mobile
 * - Robust CPU / WebAssembly (WASM) fallback
 * - Device Capability Detection (Lightweight Tiny model on Mobile, Base on Desktop)
 * - Three core languages: Malayalam (ml-IN), Arabic (ar-SA), English (en-US)
 * - Automatic Language & Script detection with native writing systems
 * - Start, Pause, Resume, Stop controls with session continuity
 * - Zero Duplication: Disjoint audio chunking + unique segment ID registry
 * - Editable textarea, Copy to clipboard, and .txt file download
 * - Offline model caching via Cache API
 */

// -------------------------------------------------------------
// 0. Configuration & Registries
// -------------------------------------------------------------

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

// Open-source Multilingual Whisper models on Hugging Face Hub (ONNX)
const MODEL_REGISTRY = {
  tiny:  { id: 'onnx-community/whisper-tiny',           label: 'Whisper Tiny (~40 MB)',  sizeMb: 40,  tier: 'mobile' },
  base:  { id: 'onnx-community/whisper-base',           label: 'Whisper Base (~80 MB)',  sizeMb: 80,  tier: 'balanced' },
  small: { id: 'onnx-community/whisper-small',          label: 'Whisper Small (~250 MB)', sizeMb: 250, tier: 'accuracy' },
  turbo: { id: 'onnx-community/whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo (~800 MB)', sizeMb: 800, tier: 'gpu' }
};

// Supported Languages Configuration
const LANG_CONFIG = {
  MALAYALAM: { code: 'ml-IN', short: 'ml', name: 'Malayalam', badge: 'Primary', script: 'മലയാളം' },
  ARABIC:    { code: 'ar-SA', short: 'ar', name: 'Arabic',    badge: 'Secondary', script: 'العربية' },
  ENGLISH:   { code: 'en-US', short: 'en', name: 'English',   badge: 'Tertiary', script: 'English' }
};

// Regex patterns for script detection
const SCRIPT_PATTERNS = {
  malayalam: /[\u0D00-\u0D7F]/,
  arabic:    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  english:   /[a-zA-Z]/
};

// Audio capture + Voice Activity Detection (VAD) settings
const AUDIO = {
  SAMPLE_RATE: 16000,        // 16 kHz mono PCM required by Whisper
  FRAME_MS: 20,              // VAD evaluation frame resolution
  PROCESSOR_BUFFER: 1024,    // ScriptProcessor window size (~64 ms)
  CALIBRATION_MS: 600,       // Ambient room noise calibration duration
  MIN_GATE: 0.0045,          // Minimum audio threshold gate
  NOISE_MULTIPLIER: 2.6,     // Gate = max(MIN_GATE, noiseFloor * 2.6)
  MIN_SPEECH_MS: 160,        // Voiced duration needed to trigger speech onset
  SILENCE_CLOSE_MS: 700,     // Pause duration to cut a phrase chunk
  TAIL_KEEP_MS: 180,         // Silence preserved at end of chunk to avoid clipping
  MIN_CHUNK_MS: 450,         // Discard noise blips under 450 ms
  MAX_CHUNK_MS: 12000,       // Maximum chunk length before forcing a cut
  PREROLL_MS: 300            // Audio retained before speech onset
};

const FRAME_SIZE = Math.round((AUDIO.SAMPLE_RATE * AUDIO.FRAME_MS) / 1000);
const PREROLL_FRAMES = Math.round(AUDIO.PREROLL_MS / AUDIO.FRAME_MS);
const CALIBRATION_FRAMES = Math.round(AUDIO.CALIBRATION_MS / AUDIO.FRAME_MS);

// Unicode marks for proper RTL Arabic embedding in LTR contexts
const RLE = '\u202B';
const PDF = '\u202C';

// -------------------------------------------------------------
// 0b. ASR Worker Script Source (Runs off main UI thread)
// -------------------------------------------------------------

const ASR_WORKER_SOURCE = [
  "'use strict';",
  "",
  "const CDN_URL = " + JSON.stringify(TRANSFORMERS_CDN) + ";",
  "let libPromise = null;",
  "",
  "function loadLibrary() {",
  "  if (!libPromise) {",
  "    libPromise = (async function () {",
  "      try {",
  "        const mod = await import(CDN_URL);",
  "        if (mod && typeof mod.pipeline === 'function') return mod;",
  "      } catch (e1) {",
  "        try {",
  "          const mod2 = await import(CDN_URL + '/dist/transformers.js');",
  "          if (mod2 && typeof mod2.pipeline === 'function') return mod2;",
  "        } catch (e2) {",
  "          throw new Error('Failed to load Transformers.js from CDN: ' + (e2.message || e1.message));",
  "        }",
  "      }",
  "      throw new Error('Transformers.js pipeline function not found.');",
  "    })();",
  "  }",
  "  return libPromise;",
  "}",
  "",
  "let transcriber = null;",
  "let activeModelId = null;",
  "let activeDevice = null;",
  "let chain = Promise.resolve();",
  "",
  "function emit(msg) { self.postMessage(msg); }",
  "function errText(e) { return (e && e.message) ? e.message : String(e); }",
  "",
  "self.addEventListener('message', function (event) {",
  "  const data = event.data || {};",
  "  if (data.type === 'load') {",
  "    chain = chain.then(function () { return doLoad(data); }, function () { return doLoad(data); });",
  "  } else if (data.type === 'transcribe') {",
  "    chain = chain.then(function () { return doTranscribe(data); }, function () { return doTranscribe(data); });",
  "  }",
  "});",
  "",
  "async function doLoad(data) {",
  "  try {",
  "    const mod = await loadLibrary();",
  "    const env = mod.env;",
  "    env.allowLocalModels = false;",
  "    env.useBrowserCache = true;",
  "",
  "    // Probe if WebGPU is available in this worker context",
  "    let hasWebGPU = false;",
  "    if (typeof navigator !== 'undefined' && navigator.gpu) {",
  "      try {",
  "        const adapter = await navigator.gpu.requestAdapter();",
  "        if (adapter) hasWebGPU = true;",
  "      } catch (gpuErr) {",
  "        hasWebGPU = false;",
  "      }",
  "    }",
  "",
  "    const requestedBackend = data.device || 'auto';",
  "    const candidates = [];",
  "",
  "    // 1. WebGPU candidates if supported or explicitly requested",
  "    if (requestedBackend === 'webgpu' || (requestedBackend === 'auto' && hasWebGPU)) {",
  "      candidates.push({",
  "        device: 'webgpu',",
  "        dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },",
  "        label: 'WebGPU (Hardware GPU Accelerated)'",
  "      });",
  "      candidates.push({",
  "        device: 'webgpu',",
  "        dtype: 'q4',",
  "        label: 'WebGPU (Q4 Quantized)'",
  "      });",
  "    }",
  "",
  "    // 2. WebAssembly CPU fallbacks (universal compatibility on Desktop & Mobile)",
  "    candidates.push({",
  "      device: 'wasm',",
  "      dtype: 'q4',",
  "      label: 'WebAssembly (CPU Q4 - Memory Efficient)'",
  "    });",
  "    candidates.push({",
  "      device: 'wasm',",
  "      dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' },",
  "      label: 'WebAssembly (CPU FP32/Q4)'",
  "    });",
  "    candidates.push({",
  "      device: 'wasm',",
  "      dtype: 'fp32',",
  "      label: 'WebAssembly (CPU Standard)'",
  "    });",
  "",
  "    let lastError = null;",
  "    let loadedConfig = null;",
  "",
  "    for (let i = 0; i < candidates.length; i++) {",
  "      const c = candidates[i];",
  "      try {",
  "        emit({ type: 'status', message: 'Initializing weights on ' + c.label + '…' });",
  "        transcriber = await mod.pipeline('automatic-speech-recognition', data.model, {",
  "          device: c.device,",
  "          dtype: c.dtype,",
  "          progress_callback: function (p) {",
  "            emit({ type: 'progress', payload: p });",
  "          }",
  "        });",
  "        loadedConfig = c;",
  "        lastError = null;",
  "        break; // Pipeline initialized successfully!",
  "      } catch (cErr) {",
  "        lastError = cErr;",
  "        transcriber = null;",
  "        emit({ type: 'status', message: c.label + ' unavailable: ' + errText(cErr) + '. Trying fallback…' });",
  "      }",
  "    }",
  "",
  "    if (!transcriber) {",
  "      throw (lastError || new Error('Unable to initialize speech recognition on any device backend.'));",
  "    }",
  "",
  "    activeModelId = data.model;",
  "    activeDevice = loadedConfig.device;",
  "    emit({",
  "      type: 'loaded',",
  "      model: data.model,",
  "      device: loadedConfig.device,",
  "      description: loadedConfig.label",
  "    });",
  "  } catch (err) {",
  "    emit({ type: 'error', scope: 'load', message: errText(err) });",
  "  }",
  "}",
  "",
  "async function doTranscribe(data) {",
  "  if (!transcriber) {",
  "    emit({ type: 'error', scope: 'transcribe', id: data.id, message: 'Whisper model is not loaded.' });",
  "    return;",
  "  }",
  "",
  "  try {",
  "    const options = {",
  "      task: 'transcribe',",
  "      return_timestamps: false",
  "    };",
  "    if (data.language) {",
  "      options.language = data.language;",
  "    }",
  "",
  "    // Optional interim token streamer for real-time visual typing feedback",
  "    try {",
  "      const mod = await loadLibrary();",
  "      if (mod.TextStreamer && transcriber.tokenizer) {",
  "        let accumulated = '';",
  "        options.streamer = new mod.TextStreamer(transcriber.tokenizer, {",
  "          skip_prompt: true,",
  "          skip_special_tokens: true,",
  "          callback_function: function (token) {",
  "            accumulated += token;",
  "            emit({ type: 'partial', id: data.id, text: accumulated });",
  "          }",
  "        });",
  "      }",
  "    } catch (sErr) {",
  "      delete options.streamer;",
  "    }",
  "",
  "    let output = null;",
  "    try {",
  "      output = await transcriber(data.audio, options);",
  "    } catch (runErr) {",
  "      // Fallback: retry once without streamer if it was an issue",
  "      if (options.streamer) {",
  "        delete options.streamer;",
  "        output = await transcriber(data.audio, options);",
  "      } else {",
  "        throw runErr;",
  "      }",
  "    }",
  "",
  "    const text = (output && typeof output.text === 'string') ? output.text.trim() : '';",
  "    emit({",
  "      type: 'result',",
  "      id: data.id,",
  "      text: text,",
  "      language: data.language || null",
  "    });",
  "  } catch (err) {",
  "    emit({ type: 'error', scope: 'transcribe', id: data.id, message: errText(err) });",
  "  }",
  "}"
].join('\n');

// -------------------------------------------------------------
// 1. Application State
// -------------------------------------------------------------

let appState = 'idle';           // 'idle' | 'recording' | 'paused' | 'stopped'
let activeMode = 'auto';         // 'auto' | 'ml-IN' | 'ar-SA' | 'en-US'
let currentLangCode = 'ml-IN';   // Primary default is Malayalam
let detectedLang = LANG_CONFIG.MALAYALAM;

// Single Source of Truth for confirmed text in editor
let finalTranscript = '';

// Unique Segment Registry: GUARANTEES zero duplicate segments
let segmentCounter = 0;
const committedSegmentIds = new Set();
const committedSegments = [];

// Incremented on "Clear Text" to invalidate in-flight chunk decodes
let transcriptGeneration = 0;

// On-Device Engine State
let asrWorker = null;
let modelReady = false;
let modelLoading = false;
let pendingModelKey = null;
let loadedModelKey = null;
let loadedDeviceLabel = '';
let modelLoadResolve = null;
let pendingModelLoad = null;
const modelFileProgress = new Map();

// Transcription Queue (FIFO order, 1 active chunk decode at a time)
const transcriptionQueue = [];
let activeJob = null;
let partialText = '';
let segmentsDone = 0;
let segmentsQueued = 0;

// Audio Capture & Graph Nodes
let micStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let muteNode = null;
let captureSampleRate = AUDIO.SAMPLE_RATE;

// Voice Activity Detection (VAD) & Frame Assembly State
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

// Device Profile State
let deviceProfile = null;

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

// Engine Card Elements
const loadModelBtn = document.getElementById('loadModelBtn');
const loadModelBtnText = document.getElementById('loadModelBtnText');
const modelSelect = document.getElementById('modelSelect');
const deviceSelect = document.getElementById('deviceSelect');
const modelStatus = document.getElementById('modelStatus');
const modelPct = document.getElementById('modelPct');
const modelBar = document.getElementById('modelBar');
const deviceCapabilityBanner = document.getElementById('deviceCapabilityBanner');
const deviceCapabilityIcon = document.getElementById('deviceCapabilityIcon');
const deviceCapabilityText = document.getElementById('deviceCapabilityText');

// Diagnostic Panel Elements
const debugPanel = document.getElementById('debugPanel');
const debugContent = document.getElementById('debugContent');
const toggleDebugBtn = document.getElementById('toggleDebugBtn');
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
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 3000);
}

// -------------------------------------------------------------
// 4. Device Capability & Mobile Detection
// -------------------------------------------------------------

function detectDeviceCapabilities() {
  const ua = navigator.userAgent || '';
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
    (navigator.maxTouchPoints && navigator.maxTouchPoints > 2 && window.innerWidth <= 850);

  const hasWebGPU = Boolean(typeof navigator !== 'undefined' && navigator.gpu);
  const cores = navigator.hardwareConcurrency || 4;
  const memoryGB = navigator.deviceMemory || (isMobile ? 4 : 8);

  return {
    isMobile,
    hasWebGPU,
    cores,
    memoryGB,
    recommendedModel: isMobile ? 'tiny' : 'base'
  };
}

function applyDeviceProfile() {
  deviceProfile = detectDeviceCapabilities();

  // If on mobile device, configure appropriate lightweight defaults
  if (deviceProfile.isMobile) {
    if (modelSelect) modelSelect.value = 'tiny';
    if (deviceCapabilityText && deviceCapabilityIcon) {
      deviceCapabilityIcon.setAttribute('data-lucide', 'smartphone');
      deviceCapabilityText.textContent = `Mobile device detected (${deviceProfile.cores} cores) · Whisper Tiny (~40 MB) selected for low memory and battery saving.`;
    }
  } else {
    if (deviceCapabilityText && deviceCapabilityIcon) {
      if (deviceProfile.hasWebGPU) {
        deviceCapabilityIcon.setAttribute('data-lucide', 'zap');
        deviceCapabilityText.textContent = `Desktop detected · WebGPU hardware acceleration supported for ultra-fast transcription.`;
      } else {
        deviceCapabilityIcon.setAttribute('data-lucide', 'monitor');
        deviceCapabilityText.textContent = `Desktop detected (${deviceProfile.cores} cores) · WebAssembly CPU mode with memory-efficient quantization ready.`;
      }
    }
  }
  if (window.lucide) lucide.createIcons();
}

// -------------------------------------------------------------
// 5. Interim & Speech Stream Visuals
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

function updateInterimState() {
  const pending = transcriptionQueue.length + (activeJob ? 1 : 0);

  if (partialText) {
    showInterim(partialText);
    return;
  }
  if (activeJob) {
    showInterim(pending > 1
      ? `⏳ Transcribing segment ${segmentsDone + 1} of ${segmentsDone + pending}…`
      : '⏳ Transcribing spoken audio…');
    return;
  }
  if (speechActive) {
    showInterim('🎙️ Capturing speech…');
    return;
  }
  if (appState === 'recording') {
    showInterim('🎙️ Listening for voice…');
    return;
  }
  hideInterim();
}

// -------------------------------------------------------------
// 6. Microphone Permissions & Support Check
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
  const hasAudio = Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const hasWebGPU = typeof navigator !== 'undefined' && Boolean(navigator.gpu);
  return {
    ok: hasWebAssembly && hasWorker && hasAudio,
    hasWebGPU
  };
}

// -------------------------------------------------------------
// 7. Script & Language Classification
// -------------------------------------------------------------

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
// 8. Segment Registry (ZERO DUPLICATION GUARANTEE)
// -------------------------------------------------------------

function makeSegmentId(prefix) {
  segmentCounter += 1;
  return `${prefix}-${segmentCounter}-${Date.now()}`;
}

function appendToTranscript(text) {
  const clean = text.trim();
  if (!clean) return;

  let out = finalTranscript;

  if (out.length > 0 && !/\s$/.test(out)) {
    // Add appropriate spacing or line-break based on punctuation
    out += /[.!?।؟]$/.test(out.trim()) ? '\n' : ' ';
  }

  finalTranscript = out + clean;
  textEditor.value = finalTranscript;
  updateCounters();
  textEditor.scrollTop = textEditor.scrollHeight;
}

function commitSegment(langCode, text, providedId) {
  const id = providedId || makeSegmentId('seg');
  
  // Guard: if this exact segment id has already been committed, drop it!
  if (committedSegmentIds.has(id)) return false;
  if (!text || !text.trim()) return false;

  const langObj = Object.values(LANG_CONFIG).find(l => l.code === langCode) || detectedLang;
  
  // Arabic RTL formatting
  const rendered = langObj.code === LANG_CONFIG.ARABIC.code ? RLE + text.trim() + PDF : text.trim();

  committedSegmentIds.add(id);
  committedSegments.push({ id, lang: langObj.code, text: text.trim() });

  appendToTranscript(rendered);

  if (langObj.code !== detectedLang.code) {
    updateLanguageUI(langObj);
  }

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
// 9. Diagnostics Helpers
// -------------------------------------------------------------

function setErrorDiagnostic(text) {
  if (!dbgError) return;
  dbgError.textContent = text;
  dbgError.className = text === 'None'
    ? 'font-semibold text-slate-400 text-xs mt-0.5 truncate'
    : 'font-semibold text-rose-400 text-xs mt-0.5 truncate';
}

function updateLevelDiagnostic(rms, gate, calibrating) {
  if (!dbgSpeech) return;
  const now = Date.now();
  if (now - lastLevelUiAt < 250) return;
  lastLevelUiAt = now;

  if (rms > gate) {
    dbgSpeech.textContent = calibrating
      ? 'Calibrating mic…'
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
// 10. Model Loading & Download Progress Tracking
// -------------------------------------------------------------

function setModelProgress(percent, statusText, isError = false) {
  const pct = Math.max(0, Math.min(100, Math.round(percent || 0)));
  if (modelBar) modelBar.style.width = pct + '%';
  if (modelPct) modelPct.textContent = pct + '%';
  if (modelStatus) {
    modelStatus.textContent = statusText;
    modelStatus.className = isError
      ? 'text-rose-500 dark:text-rose-400 font-semibold'
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
    setErrorDiagnostic('Worker error: ' + (event.message || 'script execution failed'));
    setModelProgress(0, 'Inference worker could not start.', true);
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
  modelFileProgress.forEach((entry) => {
    loaded += entry.loaded;
    total += entry.total;
  });

  if (total > 0) {
    const mb = (v) => (v / 1048576).toFixed(1);
    const pct = Math.min(99, Math.round((loaded / total) * 100));
    setModelProgress(pct, `Downloading model weights: ${mb(loaded)} MB / ${mb(total)} MB (${pct}%)…`);
  }
}

function loadModel(force = false) {
  if (pendingModelLoad) return pendingModelLoad;

  const key = modelSelect ? modelSelect.value : (deviceProfile && deviceProfile.isMobile ? 'tiny' : 'base');
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
    setModelProgress(0, 'Inference worker unavailable in this browser.', true);
    showToast('Cannot initialize inference worker. Please use Google Chrome or Microsoft Edge.', 'error');
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
    loadedDeviceLabel = msg.description || (msg.device === 'webgpu' ? 'WebGPU (Hardware GPU)' : 'WebAssembly (CPU)');
    const spec = MODEL_REGISTRY[loadedModelKey] || { label: 'Whisper' };

    loadModelBtn.disabled = false;
    loadModelBtnText.textContent = 'Model Loaded ✓';
    setModelProgress(100, `${spec.label} ready · ${loadedDeviceLabel}`);
    showToast(`${spec.label} loaded on ${msg.device === 'webgpu' ? 'WebGPU (GPU)' : 'CPU (WebAssembly)'}. Click Start to speak.`, 'success');
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
      setModelProgress(0, 'Model load notice: ' + msg.message, true);
      setErrorDiagnostic('Error: ' + msg.message);
      showToast('Model loading error: ' + msg.message, 'error');
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
// 11. Transcription Queue (FIFO, One Active Decode at a Time)
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
    let langHint = null;
    if (activeMode !== 'auto') {
      langHint = activeMode.split('-')[0]; // 'ml', 'ar', or 'en'
    }

    asrWorker.postMessage({
      type: 'transcribe',
      id: activeJob.id,
      audio: activeJob.samples,
      language: langHint
    }, [activeJob.samples.buffer]);
  } catch (err) {
    setErrorDiagnostic('Error: ' + (err && err.message ? err.message : 'postMessage failed'));
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
      // Script classification from native characters
      const classified = classifyText(msg.text);
      const reported = msg.language
        ? Object.values(LANG_CONFIG).find((l) => l.short === msg.language)
        : null;
      const langObj = classified || reported || detectedLang;
      
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
  setErrorDiagnostic('Notice: ' + msg.message);
  updateInterimState();
  pumpQueue();
}

// -------------------------------------------------------------
// 12. Audio Capture & Adaptive VAD Chunking
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

  // Calibrate background noise floor
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

  if (!speechActive) {
    prerollFrames.push(frame.slice());
    if (prerollFrames.length > PREROLL_FRAMES) prerollFrames.shift();

    onsetMs = voiced ? onsetMs + AUDIO.FRAME_MS : 0;

    if (onsetMs >= AUDIO.MIN_SPEECH_MS) {
      speechActive = true;
      chunkFrames = prerollFrames;
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
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });
  } catch (err) {
    updateMicPermissionUI('denied');
    showToast('Microphone access denied. Please click the lock icon in the URL bar and allow microphone permissions.', 'error');
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
    try { await audioContext.resume(); } catch (err) { /* resumed by click */ }
  }
  captureSampleRate = audioContext.sampleRate || AUDIO.SAMPLE_RATE;

  sourceNode = audioContext.createMediaStreamSource(micStream);
  processorNode = audioContext.createScriptProcessor(AUDIO.PROCESSOR_BUFFER, 1, 1);
  processorNode.onaudioprocess = onAudioProcess;
  sourceNode.connect(processorNode);

  muteNode = audioContext.createGain();
  muteNode.gain.value = 0;
  processorNode.connect(muteNode);
  muteNode.connect(audioContext.destination);

  resetVadState();

  if (dbgAudio) {
    dbgAudio.textContent = `Yes (${Math.round(captureSampleRate / 1000)} kHz PCM)`;
    dbgAudio.className = 'font-bold text-emerald-400 text-xs mt-0.5';
  }
  if (dbgStarted) {
    dbgStarted.textContent = 'Listening';
    dbgStarted.className = 'font-bold text-emerald-400 text-xs mt-0.5';
  }
  return true;
}

function stopCapture() {
  if (processorNode) {
    processorNode.onaudioprocess = null;
    try { processorNode.disconnect(); } catch (err) {}
    processorNode = null;
  }
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch (err) {}
    sourceNode = null;
  }
  if (muteNode) {
    try { muteNode.disconnect(); } catch (err) {}
    muteNode = null;
  }
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    try { audioContext.close(); } catch (err) {}
  }
  audioContext = null;

  resetVadState();

  if (dbgAudio) {
    dbgAudio.textContent = 'No';
    dbgAudio.className = 'font-bold text-slate-400 text-xs mt-0.5';
  }
  if (dbgStarted) {
    dbgStarted.textContent = 'Idle';
    dbgStarted.className = 'font-bold text-slate-400 text-xs mt-0.5';
  }
}

function flushPendingAudio() {
  if (speechActive) closeChunk();
}

// -------------------------------------------------------------
// 13. Session Controls (Start, Pause, Resume, Stop)
// -------------------------------------------------------------

async function ensureModelForSession() {
  const key = modelSelect ? modelSelect.value : (deviceProfile && deviceProfile.isMobile ? 'tiny' : 'base');
  if (modelReady && loadedModelKey === key) return true;

  if (modelLoading) {
    showToast('The Whisper model is still loading — one moment…', 'warning');
    return false;
  }

  showToast('Loading Whisper model for local transcription…', 'info');
  return await loadModel();
}

async function startSession() {
  setErrorDiagnostic('None');
  finalTranscript = textEditor.value;

  const support = detectEngineSupport();
  if (!support.ok) {
    if (unsupportedAlert) unsupportedAlert.classList.remove('hidden');
    updateStatus('unsupported');
    showToast('Browser does not support on-device WebAssembly/Worker audio processing. Use Chrome or Edge.', 'error');
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
  showToast('Microphone active. Whisper is transcribing live on your device.', 'info');
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
  showToast('Recording paused. Text preserved.', 'info');
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
  showToast('Resumed recording.', 'info');
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
  showToast('Recording stopped. In-flight audio segments are finishing transcription.', 'info');
}

// -------------------------------------------------------------
// 14. UI Controls & Status Badges
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

  const lockChoice = appState === 'recording';
  if (modelSelect) modelSelect.disabled = lockChoice;
  if (deviceSelect) deviceSelect.disabled = lockChoice;
  if (loadModelBtn) loadModelBtn.disabled = lockChoice || modelLoading;
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
// 15. Language Chips (Auto / Malayalam / Arabic / English)
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
      showToast('Auto-detect enabled. Whisper detects spoken language from audio.', 'info');
    } else {
      currentLangCode = mode;
      const langObj = Object.values(LANG_CONFIG).find(l => l.code === mode) || LANG_CONFIG.MALAYALAM;
      updateLanguageUI(langObj);
      showToast(`Language hint set to ${langObj.name}.`, 'info');
    }
  });
});

// -------------------------------------------------------------
// 16. Timer System
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
// 17. Word & Character Counters
// -------------------------------------------------------------

function updateCounters() {
  const text = textEditor.value;
  const words = text.trim().length > 0 ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  totalWordsEl.textContent = words.toLocaleString();
  totalCharsEl.textContent = text.length.toLocaleString();
  totalCharsNoSpaceEl.textContent = text.replace(/\s/g, '').length.toLocaleString();
}

textEditor.addEventListener('input', () => {
  finalTranscript = textEditor.value;
  updateCounters();
});

// -------------------------------------------------------------
// 18. Engine Card Listeners
// -------------------------------------------------------------

if (loadModelBtn) {
  loadModelBtn.addEventListener('click', async () => {
    if (modelReady && loadedModelKey === (modelSelect ? modelSelect.value : '')) {
      showToast('This model is already loaded and ready to transcribe.', 'info');
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

    transcriptionQueue.length = 0;
    segmentsQueued = segmentsDone;
    modelReady = false;
    loadedModelKey = null;
    loadModelBtnText.textContent = 'Load Model';
    setModelProgress(0, 'Model selection changed — click Load Model.');
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
    setModelProgress(0, `Backend selection changed — reload ${spec ? spec.label : 'the model'}.`);
  });
}

// -------------------------------------------------------------
// 19. Action Buttons (Copy, TXT Download, Clear, Select All)
// -------------------------------------------------------------

copyBtn.addEventListener('click', async () => {
  const text = textEditor.value.trim();
  if (!text) { showToast('No text available to copy.', 'warning'); return; }

  try {
    await navigator.clipboard.writeText(text);
    copyBtnText.textContent = 'Copied!';
    copyIcon.setAttribute('data-lucide', 'check');
    copyBtn.classList.add('bg-emerald-50', 'text-emerald-700', 'border-emerald-300', 'dark:bg-emerald-950/50', 'dark:text-emerald-300');
    if (window.lucide) lucide.createIcons();
    showToast('Transcription copied to clipboard!', 'success');

    setTimeout(() => {
      copyBtnText.textContent = 'Copy Text';
      copyIcon.setAttribute('data-lucide', 'copy');
      copyBtn.classList.remove('bg-emerald-50', 'text-emerald-700', 'border-emerald-300', 'dark:bg-emerald-950/50', 'dark:text-emerald-300');
      if (window.lucide) lucide.createIcons();
    }, 2000);
  } catch (err) {
    showToast('Failed to copy to clipboard.', 'error');
  }
});

downloadTxtBtn.addEventListener('click', () => {
  const text = textEditor.value.trim();
  if (!text) { showToast('Textarea is empty. Nothing to download.', 'warning'); return; }

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

// Diagnostic Panel Collapse/Expand Toggle
if (toggleDebugBtn && debugContent) {
  toggleDebugBtn.addEventListener('click', () => {
    const isHidden = debugContent.classList.contains('hidden');
    if (isHidden) {
      debugContent.classList.remove('hidden');
      toggleDebugBtn.textContent = 'Collapse';
    } else {
      debugContent.classList.add('hidden');
      toggleDebugBtn.textContent = 'Expand';
    }
  });
}

// -------------------------------------------------------------
// 20. Session Button Listeners
// -------------------------------------------------------------

startBtn.addEventListener('click', () => { resetTimer(); startSession(); });
pauseBtn.addEventListener('click', () => { pauseSession(); });
resumeBtn.addEventListener('click', () => { resumeSession(); });
stopBtn.addEventListener('click', () => { stopSession(); });

// -------------------------------------------------------------
// 21. Keyboard Shortcuts
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

window.addEventListener('beforeunload', () => { if (micStream) stopCapture(); });

// -------------------------------------------------------------
// 22. Light / Dark Theme
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
// 23. Application Bootstrap
// -------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();

  applyTheme((localStorage.getItem('voicetype_theme') || 'light') === 'dark');

  // Device capability detection & configuration
  applyDeviceProfile();

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
    setModelProgress(0, 'WebAssembly and Worker execution are unavailable in this browser.', true);
    return;
  }

  if (dbgSupported) {
    dbgSupported.textContent = support.hasWebGPU
      ? 'Yes (On-device · WebGPU acceleration ready)'
      : 'Yes (On-device · WebAssembly CPU mode)';
    dbgSupported.className = 'font-bold text-emerald-400 text-xs mt-0.5';
  }

  showToast('VoiceType on-device engine ready. Click Load Model, then Start.', 'info');
});
