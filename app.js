/**
 * VoiceType – Live Multilingual Speech to Text
 *
 * DUAL-ENGINE ARCHITECTURE
 * ---------------------------------------------------------------------------
 * 1. SERVER ENGINE (primary)  – records audio with MediaRecorder, splits it at
 *    natural silences into disjoint phrase chunks, and posts each chunk to
 *    /api/transcribe (OpenAI Whisper). Whisper identifies the language FROM THE
 *    AUDIO and returns text in the original writing system (Malayalam /
 *    Arabic / English). API key stays server-side.
 *
 * 2. BROWSER ENGINE (fallback) – the Web Speech API, used only when the server
 *    engine is not configured/reachable. It is append-only: it processes only
 *    new results via event.resultIndex and never rebuilds the transcript.
 *
 * DUPLICATE PREVENTION
 * ---------------------------------------------------------------------------
 * - Audio chunks are DISJOINT (the recorder is restarted after every phrase),
 *   so the same audio is never transcribed twice.
 * - Every recognized segment gets a unique id and is committed exactly once
 *   (guarded by `committedSegmentIds`).
 * - The transcript is append-only (`finalTranscript += ...`); it is never
 *   reconstructed from a cumulative result list.
 * - Genuine repetitions are preserved: there is NO text-based de-duplication.
 */

// -------------------------------------------------------------
// 0. Configuration
// -------------------------------------------------------------

const SERVER_ASR_ENDPOINT = '/api/transcribe';

// Supported Languages
const LANG_CONFIG = {
  MALAYALAM: { code: 'ml-IN', short: 'ml', name: 'Malayalam', badge: 'Primary', script: 'മലയാളം' },
  ARABIC:    { code: 'ar-SA', short: 'ar', name: 'Arabic',    badge: 'Secondary', script: 'العربية' },
  ENGLISH:   { code: 'en-US', short: 'en', name: 'English',   badge: 'Tertiary', script: 'English' }
};

const SCRIPT_PATTERNS = {
  malayalam: /[\u0D00-\u0D7F]/,
  arabic:    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  english:   /[a-zA-Z]/
};

// Voice-activity-detection tuning for the server engine.
const VAD = {
  INTERVAL_MS: 60,          // how often the mic level is sampled
  SPEECH_RMS: 0.018,        // RMS above this counts as speech
  SILENCE_FLUSH_MS: 850,    // pause length that closes a phrase
  MIN_CHUNK_MS: 700,        // ignore blips shorter than this
  MAX_CHUNK_MS: 12000       // hard cap so latency stays low
};

// -------------------------------------------------------------
// 1. Application State
// -------------------------------------------------------------

let recognition = null;          // Web Speech instance (browser engine)
let engineMode = 'browser';      // 'server' | 'browser'  (active engine)
let serverConfigured = null;     // null = probing, true/false = known

let appState = 'idle';           // 'idle' | 'recording' | 'paused' | 'stopped'
let activeMode = 'auto';         // 'auto' | 'ml-IN' | 'ar-SA' | 'en-US'
let currentLangCode = 'ml-IN';
let detectedLang = LANG_CONFIG.MALAYALAM;

// Append-only transcript model (single source of truth for the editor)
let finalTranscript = '';

// Segment store — each committed segment is recorded once, by unique id.
let segmentCounter = 0;
const committedSegmentIds = new Set();
const committedSegments = [];    // { id, lang, text }

let isIntentionalStop = false;
let isRestarting = false;
let rapidRestartCount = 0;
let lastEndAt = 0;
let resultCount = 0;
let consecutiveEnglishTokens = 0;

// Server-engine runtime handles
let micStream = null;
let audioContext = null;
let analyser = null;
let vadBuffer = null;
let vadTimer = null;
let chunkRecorder = null;
let chunkParts = [];
let chunkStartedAt = 0;
let lastVoiceAt = 0;
let sawSpeechInChunk = false;
let pendingTranscriptions = 0;
let serverFailures = 0;
let flushInFlight = false;

// RTL embedding marks so Arabic segments render right-to-left in a plain textarea
const RLE = '\u202B';
const PDF = '\u202C';

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
  lucide.createIcons();

  toast.classList.add('show');
  toastTimeout = setTimeout(() => toast.classList.remove('show'), 2800);
}

// -------------------------------------------------------------
// 4. Interim / Processing Indicator
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

// -------------------------------------------------------------
// 5. Microphone Permission & Support
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

// -------------------------------------------------------------
// 6. Language Helpers
// -------------------------------------------------------------

function langByShort(short) {
  if (!short) return null;
  const s = String(short).toLowerCase().slice(0, 2);
  return Object.values(LANG_CONFIG).find(l => l.short === s) || null;
}

function updateLanguageUI(langObj) {
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

/**
 * Browser-engine only: infer language from recognized TEXT via script ranges.
 * (The server engine detects language from the AUDIO and does not need this.)
 */
function evaluateSpokenLanguage(phrase) {
  if (!phrase || phrase.trim().length === 0) return null;

  const hasMalayalam = SCRIPT_PATTERNS.malayalam.test(phrase);
  const hasArabic = SCRIPT_PATTERNS.arabic.test(phrase);
  const englishMatches = phrase.match(/[a-zA-Z]+/g) || [];

  if (hasArabic) { consecutiveEnglishTokens = 0; return LANG_CONFIG.ARABIC; }
  if (hasMalayalam) { consecutiveEnglishTokens = 0; return LANG_CONFIG.MALAYALAM; }

  if (englishMatches.length > 0) {
    consecutiveEnglishTokens += englishMatches.length;
    if (consecutiveEnglishTokens >= 3) return LANG_CONFIG.ENGLISH;
  } else {
    consecutiveEnglishTokens = 0;
  }
  return null;
}

// -------------------------------------------------------------
// 7. Segment Store — commit each recognized segment EXACTLY ONCE
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
 * Commit a recognized segment once. Duplicate ids are ignored, so a segment
 * can never be written to the transcript twice.
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
// 8. SERVER ENGINE — MediaRecorder + Whisper via /api/transcribe
// -------------------------------------------------------------

async function probeServerEngine() {
  try {
    const res = await fetch(SERVER_ASR_ENDPOINT, { method: 'GET', cache: 'no-store' });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json();
    serverConfigured = Boolean(data && data.configured);
  } catch (err) {
    serverConfigured = false;
  }

  if (dbgSupported) {
    if (serverConfigured) {
      dbgSupported.textContent = 'Yes (Whisper Server ASR)';
      dbgSupported.className = 'font-bold text-emerald-400 text-xs mt-0.5';
    } else if (window.SpeechRecognition || window.webkitSpeechRecognition) {
      dbgSupported.textContent = 'Yes (Browser Web Speech)';
      dbgSupported.className = 'font-bold text-amber-400 text-xs mt-0.5';
    } else {
      dbgSupported.textContent = 'No (Unsupported)';
      dbgSupported.className = 'font-bold text-rose-400 text-xs mt-0.5';
    }
  }
  return serverConfigured;
}

function pickRecorderMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function beginChunk() {
  if (!micStream || appState !== 'recording') return;

  const mime = pickRecorderMime();
  try {
    chunkRecorder = mime ? new MediaRecorder(micStream, { mimeType: mime })
                         : new MediaRecorder(micStream);
  } catch (err) {
    console.warn('MediaRecorder unavailable:', err);
    return;
  }

  chunkParts = [];
  chunkStartedAt = Date.now();
  lastVoiceAt = Date.now();
  sawSpeechInChunk = false;

  chunkRecorder.ondataavailable = (e) => { if (e.data && e.data.size) chunkParts.push(e.data); };
  chunkRecorder.onstop = () => {
    const blob = new Blob(chunkParts, { type: chunkRecorder.mimeType || 'audio/webm' });
    chunkParts = [];
    sendChunkForTranscription(blob);
    if (appState === 'recording') beginChunk();
  };

  chunkRecorder.start();
}

function flushChunk() {
  if (flushInFlight) return;
  if (!chunkRecorder || chunkRecorder.state !== 'recording') return;
  flushInFlight = true;
  try {
    chunkRecorder.stop();
  } catch (err) {
    console.warn('Chunk flush notice:', err);
  } finally {
    // Released on the next tick; onstop fires synchronously after stop().
    setTimeout(() => { flushInFlight = false; }, 0);
  }
}

function startVadLoop() {
  if (vadTimer) return;
  vadTimer = setInterval(() => {
    if (appState !== 'recording' || !analyser) return;

    analyser.getByteTimeDomainData(vadBuffer);

    let sum = 0;
    for (let i = 0; i < vadBuffer.length; i++) {
      const v = (vadBuffer[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / vadBuffer.length);
    const now = Date.now();

    if (rms > VAD.SPEECH_RMS) {
      sawSpeechInChunk = true;
      lastVoiceAt = now;
      if (dbgSpeech) {
        dbgSpeech.textContent = 'Speech Detected';
        dbgSpeech.className = 'font-bold text-emerald-400 text-xs mt-0.5';
      }
    }

    const chunkAge = now - chunkStartedAt;
    const silentFor = now - lastVoiceAt;

    if (sawSpeechInChunk && silentFor > VAD.SILENCE_FLUSH_MS && chunkAge > VAD.MIN_CHUNK_MS) {
      flushChunk();                       // phrase finished — transcribe it
    } else if (chunkAge > VAD.MAX_CHUNK_MS) {
      flushChunk();                       // safety cap for very long speech
    }
  }, VAD.INTERVAL_MS);
}

function stopVadLoop() {
  if (vadTimer) { clearInterval(vadTimer); vadTimer = null; }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function sendChunkForTranscription(blob) {
  if (!blob || blob.size < 1500) return;   // silence / blip — nothing to send

  pendingTranscriptions += 1;
  showInterim(pendingTranscriptions > 1
    ? `⏳ Transcribing ${pendingTranscriptions} segments…`
    : '⏳ Transcribing…');

  const languageHint = activeMode === 'auto' ? null : activeMode.split('-')[0];

  try {
    const base64 = await blobToBase64(blob);
    const res = await fetch(SERVER_ASR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: base64, mimeType: blob.type || 'audio/webm', languageHint })
    });

    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      const detail = extractUpstreamMessage(info);
      setErrorDiagnostic(`Error: ${info.error || res.status}${detail ? ' – ' + detail : ''}`);

      if (res.status === 503) {
        serverConfigured = false;
        showToast('Server transcription is not configured (missing API key).', 'error');
      } else if (res.status === 504) {
        showToast('Transcription timed out. Check your connection.', 'warning');
      } else {
        showToast(`Transcription failed: ${detail || 'server error'}.`, 'error');
      }

      registerServerFailure();
      return;
    }

    serverFailures = 0;

    const data = await res.json();

    if (data && data.text) {
      const langObj = langByShort(data.language) || detectedLang;
      // Unique id per chunk => committed exactly once.
      commitSegment(langObj.code, data.text, makeSegmentId('chunk'));
    } else if (dbgResult) {
      recordSegmentDiagnostic();
    }

    setErrorDiagnostic('None');
  } catch (err) {
    setErrorDiagnostic('Error: network');
    showToast('Network interruption while transcribing. Will continue.', 'warning');
    registerServerFailure();
  } finally {
    pendingTranscriptions = Math.max(0, pendingTranscriptions - 1);
    if (pendingTranscriptions === 0) {
      if (appState === 'recording') showInterim('🎙 Listening…');
      else hideInterim();
    } else {
      showInterim(`⏳ Transcribing ${pendingTranscriptions} segments…`);
    }
  }
}

function setErrorDiagnostic(text) {
  if (!dbgError) return;
  dbgError.textContent = text;
  dbgError.className = text === 'None'
    ? 'font-semibold text-slate-400 text-xs mt-0.5 truncate'
    : 'font-semibold text-rose-400 text-xs mt-0.5 truncate';
}

/** Pull a human-readable reason out of an upstream error payload. */
function extractUpstreamMessage(info) {
  if (!info || typeof info.detail !== 'string' || !info.detail) return '';
  try {
    const parsed = JSON.parse(info.detail);
    const msg = parsed && parsed.error && parsed.error.message;
    if (msg) return msg;
  } catch (e) { /* detail was not JSON */ }
  return info.detail.slice(0, 120);
}

/**
 * If the server engine keeps failing, stop relying on it: the next Start
 * falls back to the browser engine so the user is never left with an app
 * that silently produces nothing.
 */
function registerServerFailure() {
  serverFailures += 1;
  if (serverFailures >= 2 && serverConfigured) {
    serverConfigured = false;
    showToast('Server transcription unavailable — browser engine will be used on next Start.', 'error');
  }
}

async function startServerEngine() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    });
  } catch (err) {
    updateMicPermissionUI('denied');
    showToast('Microphone access blocked. Allow it in the Chrome URL bar and retry.', 'error');
    return false;
  }

  updateMicPermissionUI('granted');

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(micStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  vadBuffer = new Uint8Array(analyser.fftSize);
  source.connect(analyser);

  if (dbgAudio) { dbgAudio.textContent = 'Yes (Mic Streaming)'; dbgAudio.className = 'font-bold text-emerald-400 text-xs mt-0.5'; }
  if (dbgStarted) { dbgStarted.textContent = 'Yes (Server Engine)'; dbgStarted.className = 'font-bold text-emerald-400 text-xs mt-0.5'; }

  beginChunk();
  startVadLoop();
  return true;
}

function stopServerEngine() {
  stopVadLoop();

  if (chunkRecorder && chunkRecorder.state === 'recording') {
    try { chunkRecorder.stop(); } catch (err) { /* noop */ }
  }
  chunkRecorder = null;

  if (micStream) {
    micStream.getTracks().forEach(t => t.stop());
    micStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close().catch(() => {});
  }
  audioContext = null;
  analyser = null;
  vadBuffer = null;

  if (dbgAudio) { dbgAudio.textContent = 'No'; dbgAudio.className = 'font-bold text-slate-400 text-xs mt-0.5'; }
  if (dbgStarted) { dbgStarted.textContent = 'No (Ended)'; dbgStarted.className = 'font-bold text-slate-400 text-xs mt-0.5'; }
  if (dbgSpeech) { dbgSpeech.textContent = 'No'; dbgSpeech.className = 'font-bold text-slate-400 text-xs mt-0.5'; }
}

// -------------------------------------------------------------
// 9. BROWSER ENGINE — Web Speech API (fallback), append-only
// -------------------------------------------------------------

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.lang = currentLangCode;

  rec.onstart = () => {
    isRestarting = false;
    rapidRestartCount = 0;
    appState = 'recording';
    updateControls();
    updateStatus('listening');
    startTimer();
    if (dbgStarted) { dbgStarted.textContent = 'Yes (Browser Engine)'; dbgStarted.className = 'font-bold text-emerald-400 text-xs mt-0.5'; }
    if (dbgAudio) { dbgAudio.textContent = 'Connecting...'; dbgAudio.className = 'font-bold text-amber-400 text-xs mt-0.5'; }
  };

  rec.onaudiostart = () => {
    if (dbgAudio) { dbgAudio.textContent = 'Yes (Mic Streaming)'; dbgAudio.className = 'font-bold text-emerald-400 text-xs mt-0.5'; }
  };

  rec.onspeechstart = () => {
    if (dbgSpeech) { dbgSpeech.textContent = 'Speech Detected'; dbgSpeech.className = 'font-bold text-emerald-400 text-xs mt-0.5'; }
  };

  // APPEND-ONLY handler — starts at event.resultIndex, never rebuilds.
  rec.onresult = (event) => {
    let currentInterim = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      const piece = result[0].transcript;

      if (result.isFinal) {
        // Unique per (session, resultIndex, index) => committed exactly once.
        commitSegment(
          (activeMode === 'auto'
            ? (evaluateSpokenLanguage(piece) || detectedLang).code
            : currentLangCode),
          piece,
          `ws-${sessionSeq}-${event.resultIndex}-${i}`
        );
      } else {
        currentInterim += piece;
      }
    }

    resultCount = event.results.length;
    updateCounters();
    textEditor.scrollTop = textEditor.scrollHeight;

    if (currentInterim) showInterim(currentInterim);
    else hideInterim();
  };

  rec.onerror = (event) => {
    setErrorDiagnostic(`Error: ${event.error}`);

    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showToast('Microphone access blocked. Allow it in the Chrome URL bar.', 'error');
      stopSession();
      updateMicPermissionUI('denied');
      return;
    }
    if (event.error === 'audio-capture') {
      showToast('No microphone found. Please connect one.', 'error');
      stopSession();
      return;
    }
    if (event.error === 'no-speech') return;   // normal pause in speech
    if (event.error === 'network') {
      showToast('Network error reaching the speech service.', 'error');
    }
  };

  rec.onend = () => {
    isRestarting = false;
    hideInterim();

    if (appState === 'recording' && !isIntentionalStop) {
      const now = Date.now();
      rapidRestartCount = (now - lastEndAt < 400) ? rapidRestartCount + 1 : 0;
      lastEndAt = now;

      if (rapidRestartCount > 5) {
        appState = 'stopped';
        isIntentionalStop = true;
        updateStatus('stopped');
        updateControls();
        stopTimer();
        showToast('Recognition stopped after repeated errors. Press Start to retry.', 'error');
        return;
      }

      setTimeout(() => {
        if (appState === 'recording') {
          try { rec.lang = currentLangCode; rec.start(); }
          catch (err) { console.warn('Auto-restart notice:', err); }
        }
      }, 150);
      return;
    }

    if (appState === 'paused') { updateStatus('paused'); updateControls(); stopTimer(); }
    else if (appState === 'stopped') { updateStatus('stopped'); updateControls(); stopTimer(); }
  };

  return rec;
}

// -------------------------------------------------------------
// 10. Session Controls (route to the active engine)
// -------------------------------------------------------------

let sessionSeq = 0;

async function startSession() {
  isIntentionalStop = false;
  isRestarting = false;
  resultCount = 0;
  sessionSeq += 1;

  finalTranscript = textEditor.value;
  setErrorDiagnostic('None');

  // Decide the engine once (probe if not yet known).
  if (serverConfigured === null) await probeServerEngine();

  if (serverConfigured) {
    engineMode = 'server';
    const ok = await startServerEngine();
    if (ok) {
      appState = 'recording';
      updateControls();
      updateStatus('listening');
      startTimer();
      showInterim('🎙 Listening…');
      showToast('Listening — language is detected automatically from your voice.', 'info');
    }
    return;
  }

  // Fallback: browser Web Speech API
  engineMode = 'browser';
  if (!recognition) recognition = initSpeechRecognition();

  if (!recognition) {
    if (unsupportedAlert) unsupportedAlert.classList.remove('hidden');
    updateStatus('unsupported');
    if (startBtn) startBtn.disabled = true;
    showToast('No speech engine available in this browser. Use Google Chrome.', 'error');
    return;
  }

  recognition.lang = currentLangCode;
  try {
    recognition.start();
    showToast(`Microphone active (browser engine). Listening in ${detectedLang.name}…`, 'info');
  } catch (err) {
    console.warn('Recognition start caught:', err);
  }
}

function pauseSession() {
  if (appState !== 'recording') return;

  appState = 'paused';
  isIntentionalStop = true;

  if (engineMode === 'server') {
    flushChunk();               // transcribe whatever phrase was in progress
    stopVadLoop();
    if (chunkRecorder) { try { chunkRecorder.stop(); } catch (e) { /* noop */ } }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  } else if (recognition) {
    try { recognition.stop(); } catch (err) { console.warn(err); }
  }

  hideInterim();
  stopTimer();
  updateStatus('paused');
  updateControls();
  showToast('Recording paused. Text preserved.', 'info');
}

async function resumeSession() {
  if (appState !== 'paused') return;

  isIntentionalStop = false;
  finalTranscript = textEditor.value;

  if (engineMode === 'server') {
    const ok = await startServerEngine();
    if (ok) {
      appState = 'recording';
      updateControls();
      updateStatus('listening');
      startTimer();
      showInterim('🎙 Listening…');
      showToast('Resumed — listening.', 'info');
    }
    return;
  }

  if (!recognition) recognition = initSpeechRecognition();
  if (!recognition) return;

  recognition.lang = currentLangCode;
  try {
    recognition.start();
    appState = 'recording';
    updateControls();
    updateStatus('listening');
    startTimer();
    showToast(`Resumed (${detectedLang.name})…`, 'info');
  } catch (err) {
    console.warn('Resume notice:', err);
  }
}

function stopSession() {
  if (appState === 'idle' || appState === 'stopped') return;

  appState = 'stopped';
  isIntentionalStop = true;

  if (engineMode === 'server') {
    flushChunk();
    stopServerEngine();
  } else if (recognition) {
    try { recognition.stop(); } catch (err) { console.warn(err); }
  }

  hideInterim();
  finalTranscript = textEditor.value;
  updateCounters();
  stopTimer();
  updateStatus('stopped');
  updateControls();
  showToast('Recording session stopped.', 'info');
}

// -------------------------------------------------------------
// 11. Controls & Status
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
// 12. Language Chips (Auto detect + optional manual hint)
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
      showToast('Auto-detect enabled — language identified from your voice.', 'info');
    } else {
      currentLangCode = mode;
      const langObj = Object.values(LANG_CONFIG).find(l => l.code === mode) || LANG_CONFIG.MALAYALAM;
      updateLanguageUI(langObj);
      showToast(`Language hint set to ${langObj.name}.`, 'info');
    }
  });
});

// -------------------------------------------------------------
// 13. Timer (MM:SS)
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
// 14. Word & Character Counters
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
// 15. Actions (Copy, Download TXT, Clear, Select All)
// -------------------------------------------------------------

copyBtn.addEventListener('click', async () => {
  const text = textEditor.value.trim();
  if (!text) { showToast('There is no text to copy!', 'warning'); return; }

  try {
    await navigator.clipboard.writeText(text);
    copyBtnText.textContent = 'Copied!';
    copyIcon.setAttribute('data-lucide', 'check');
    copyBtn.classList.add('bg-emerald-50', 'text-emerald-700', 'border-emerald-300', 'dark:bg-emerald-950/50', 'dark:text-emerald-300');
    lucide.createIcons();
    showToast('Text copied to clipboard!', 'success');

    setTimeout(() => {
      copyBtnText.textContent = 'Copy Text';
      copyIcon.setAttribute('data-lucide', 'copy');
      copyBtn.classList.remove('bg-emerald-50', 'text-emerald-700', 'border-emerald-300', 'dark:bg-emerald-950/50', 'dark:text-emerald-300');
      lucide.createIcons();
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
    textEditor.value = '';
    finalTranscript = '';
    resultCount = 0;
    clearSegments();
    hideInterim();
    resetTimer();
    updateCounters();
    if (dbgResult) dbgResult.textContent = '0 results received';
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
// 16. Button Listeners
// -------------------------------------------------------------

startBtn.addEventListener('click', () => { resetTimer(); startSession(); });
pauseBtn.addEventListener('click', () => { pauseSession(); });
resumeBtn.addEventListener('click', () => { resumeSession(); });
stopBtn.addEventListener('click', () => { stopSession(); });

// -------------------------------------------------------------
// 17. Keyboard Shortcuts
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

// -------------------------------------------------------------
// 18. Light / Dark Theme
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
  lucide.createIcons();
}

themeToggleBtn.addEventListener('click', () => {
  applyTheme(!document.documentElement.classList.contains('dark'));
});

// -------------------------------------------------------------
// 19. Bootstrap
// -------------------------------------------------------------

window.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();

  applyTheme((localStorage.getItem('voicetype_theme') || 'light') === 'dark');

  checkMicrophonePermission();
  updateControls();
  updateStatus('ready');
  updateCounters();
  updateLanguageUI(LANG_CONFIG.MALAYALAM);

  // Pre-flight: is the server engine available? If not, prepare the fallback.
  const configured = await probeServerEngine();
  if (configured) {
    showToast('Multilingual engine ready — press Start and speak.', 'success');
  } else {
    recognition = initSpeechRecognition();
    if (!recognition && unsupportedAlert) unsupportedAlert.classList.remove('hidden');
    showToast('Server engine not configured — using browser speech engine.', 'warning');
  }
});
