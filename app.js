/**
 * VoiceType – Live Speech to Text
 * Pure Vanilla JavaScript implementation of Web Speech API
 * 
 * Features:
 * - Direct, rock-solid SpeechRecognition lifecycle (ZERO hardware mic conflicts)
 * - Intelligent Multilingual Auto-Detection (Malayalam [Primary], Arabic, English)
 * - Loanword Hysteresis Filter (Preserves Malayalam on single English loanwords)
 * - Original Script Preservation (Malayalam, Arabic, English)
 * - Start, Pause, Resume, Stop controls with session continuity
 * - Word & Character Counters (Words, Chars, Chars excluding spaces)
 * - Copy Text, Download TXT, Clear Text, Select All
 * - MM:SS Timer, Light/Dark Mode, and Keyboard Shortcuts
 */

// Supported Languages & Priority Configuration
const LANG_CONFIG = {
  MALAYALAM: { code: 'ml-IN', name: 'Malayalam', badge: 'Primary', script: 'മലയാളം' },
  ARABIC:    { code: 'ar-SA', name: 'Arabic',    badge: 'Secondary', script: 'العربية' },
  ENGLISH:   { code: 'en-US', name: 'English',   badge: 'Tertiary', script: 'English' }
};

// Regex patterns for script recognition
const SCRIPT_PATTERNS = {
  malayalam: /[\u0D00-\u0D7F]/,
  arabic:    /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/,
  english:   /[a-zA-Z]/
};

// Application State
let recognition = null;
let appState = 'idle'; // 'idle' | 'recording' | 'paused' | 'stopped'
let activeMode = 'auto'; // 'auto' | 'ml-IN' | 'ar-SA' | 'en-US'
let currentLangCode = LANG_CONFIG.MALAYALAM.code; // Default = Malayalam
let detectedLang = LANG_CONFIG.MALAYALAM;

let finalTranscript = '';
let interimTranscript = '';
let isIntentionalStop = false;
let consecutiveEnglishTokens = 0;
let isRestarting = false;

// Timer State
let timerInterval = null;
let elapsedSeconds = 0;

// DOM Elements
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

// -------------------------------------------------------------
// 1. Toast Notification System
// -------------------------------------------------------------
let toastTimeout = null;

function showToast(message, type = 'success') {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
  }

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
  toastTimeout = setTimeout(() => {
    toast.classList.remove('show');
  }, 2800);
}

// -------------------------------------------------------------
// 2. Language Detection & Hysteresis Controller
// -------------------------------------------------------------

/**
 * Evaluates spoken phrase for Malayalam, Arabic, or English
 * Applies hysteresis to ignore 1-2 isolated English loanwords in Malayalam
 */
function evaluateSpokenLanguage(phrase) {
  if (!phrase || phrase.trim().length === 0) return null;

  const hasMalayalam = SCRIPT_PATTERNS.malayalam.test(phrase);
  const hasArabic = SCRIPT_PATTERNS.arabic.test(phrase);
  const englishMatches = phrase.match(/[a-zA-Z]+/g) || [];

  // 1. Arabic: High confidence on Arabic script
  if (hasArabic) {
    consecutiveEnglishTokens = 0;
    return LANG_CONFIG.ARABIC;
  }

  // 2. Malayalam: Highest priority
  if (hasMalayalam) {
    consecutiveEnglishTokens = 0;
    return LANG_CONFIG.MALAYALAM;
  }

  // 3. English Hysteresis Check:
  // Malayalam speakers frequently use single English loanwords (e.g., "school", "bus", "time", "class").
  // Do NOT switch if there is only 1 or 2 isolated English words while in Malayalam mode.
  if (englishMatches.length > 0) {
    consecutiveEnglishTokens += englishMatches.length;

    // Switch only after 3+ consecutive English words without Malayalam
    if (consecutiveEnglishTokens >= 3) {
      return LANG_CONFIG.ENGLISH;
    }
  } else {
    consecutiveEnglishTokens = 0;
  }

  return null;
}

/**
 * Updates UI badge for detected language
 */
function updateLanguageUI(langObj) {
  detectedLang = langObj;
  detectedLangName.textContent = langObj.name;
  detectedLangBadge.textContent = langObj.badge;

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
 * Transitions recognition to a new language smoothly
 */
function switchRecognitionLanguage(newLangCode, isUserOverride = false) {
  if (currentLangCode === newLangCode && !isUserOverride) return;

  currentLangCode = newLangCode;
  const langObj = Object.values(LANG_CONFIG).find(l => l.code === newLangCode) || LANG_CONFIG.MALAYALAM;
  updateLanguageUI(langObj);

  if (recognition) {
    recognition.lang = newLangCode;

    // If currently recording, safely restart to rebind acoustic model
    if (appState === 'recording' && !isRestarting) {
      isRestarting = true;
      try {
        recognition.stop();
      } catch (e) {
        isRestarting = false;
      }
    }
  }
}

// -------------------------------------------------------------
// 3. Web Speech API Lifecycle & Engine Management
// -------------------------------------------------------------

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    if (unsupportedAlert) unsupportedAlert.classList.remove('hidden');
    startBtn.disabled = true;
    updateStatus('unsupported');
    return null;
  }

  // Ensure unsupported banner is hidden on supported browsers
  if (unsupportedAlert) unsupportedAlert.classList.add('hidden');

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.lang = currentLangCode;

  rec.onstart = () => {
    isRestarting = false;
    appState = 'recording';
    updateControls();
    updateStatus('listening');
    startTimer();
  };

  rec.onresult = (event) => {
    let currentInterim = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const piece = event.results[i][0].transcript;

      if (event.results[i].isFinal) {
        // Automatic language evaluation in Auto mode
        if (activeMode === 'auto') {
          const detected = evaluateSpokenLanguage(piece);
          if (detected && detected.code !== currentLangCode) {
            switchRecognitionLanguage(detected.code);
          }
        }

        // Append finalized text seamlessly
        if (finalTranscript.length > 0 && !finalTranscript.endsWith(' ') && !finalTranscript.endsWith('\n')) {
          finalTranscript += ' ';
        }
        finalTranscript += piece.trim();
        textEditor.value = finalTranscript;
        updateCounters();

        // Auto-scroll textarea to bottom
        textEditor.scrollTop = textEditor.scrollHeight;
      } else {
        currentInterim += piece;
      }
    }

    interimTranscript = currentInterim;

    // Display provisional / interim text separately to avoid text duplication
    if (interimTranscript.trim().length > 0) {
      if (activeMode === 'auto') {
        const interimDetected = evaluateSpokenLanguage(interimTranscript);
        if (interimDetected && interimDetected.code !== currentLangCode) {
          detectedLangName.textContent = interimDetected.name;
        }
      }

      interimStream.classList.remove('hidden');
      interimText.textContent = interimTranscript;
    } else {
      interimStream.classList.add('hidden');
      interimText.textContent = '';
    }
  };

  rec.onerror = (event) => {
    console.warn('Speech recognition notice:', event.error);

    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showToast('Microphone access blocked. Please allow microphone permission in your browser.', 'error');
      stopSession();
      return;
    }

    if (event.error === 'audio-capture') {
      showToast('No microphone found. Please connect or select an active microphone.', 'error');
      stopSession();
      return;
    }

    if (event.error === 'no-speech') {
      // Normal pause in speech: do nothing, maintain session
      return;
    }

    if (event.error === 'network') {
      showToast('Network issue with speech recognition service.', 'warning');
    }
  };

  rec.onend = () => {
    isRestarting = false;

    // If still in recording mode and not paused or stopped, restart with debounce
    if (appState === 'recording' && !isIntentionalStop) {
      setTimeout(() => {
        if (appState === 'recording') {
          try {
            rec.lang = currentLangCode;
            rec.start();
          } catch (err) {
            console.warn('Recognition restart notice:', err);
          }
        }
      }, 150);
    } else if (appState === 'paused') {
      updateStatus('paused');
      updateControls();
      stopTimer();
      hideInterim();
    } else {
      updateStatus('stopped');
      updateControls();
      stopTimer();
      hideInterim();
    }
  };

  return rec;
}

function hideInterim() {
  interimTranscript = '';
  interimStream.classList.add('hidden');
  interimText.textContent = '';
}

// -------------------------------------------------------------
// 4. Session Controls (Start, Pause, Resume, Stop)
// -------------------------------------------------------------

function startSession() {
  if (!recognition) {
    recognition = initSpeechRecognition();
    if (!recognition) return;
  }

  isIntentionalStop = false;
  isRestarting = false;
  consecutiveEnglishTokens = 0;

  // Set default language model
  recognition.lang = currentLangCode;

  try {
    recognition.start();
    showToast(`Listening in ${detectedLang.name}...`, 'info');
  } catch (err) {
    // If already active or starting, gracefully ignore
    console.warn('Recognition start caught:', err);
  }
}

function pauseSession() {
  if (appState !== 'recording') return;

  appState = 'paused';
  isIntentionalStop = true;

  try {
    recognition.stop();
  } catch (err) {
    console.warn(err);
  }

  stopTimer();
  updateStatus('paused');
  updateControls();
  hideInterim();
  showToast('Recording paused. Text preserved.', 'info');
}

function resumeSession() {
  if (appState !== 'paused') return;

  isIntentionalStop = false;
  recognition.lang = currentLangCode;

  try {
    recognition.start();
    appState = 'recording';
    updateControls();
    updateStatus('listening');
    startTimer();
    showToast(`Resuming (${detectedLang.name})...`, 'info');
  } catch (err) {
    console.warn('Resume notice:', err);
  }
}

function stopSession() {
  if (appState === 'idle' || appState === 'stopped') return;

  appState = 'stopped';
  isIntentionalStop = true;

  try {
    recognition.stop();
  } catch (err) {
    console.warn(err);
  }

  stopTimer();
  updateStatus('stopped');
  updateControls();
  hideInterim();
  showToast('Recording session stopped.', 'info');
}

// -------------------------------------------------------------
// 5. Controls & Status Indicator Management
// -------------------------------------------------------------

function updateControls() {
  if (appState === 'recording') {
    startBtn.disabled = true;
    pauseBtn.disabled = false;
    resumeBtn.disabled = true;
    stopBtn.disabled = false;
  } else if (appState === 'paused') {
    startBtn.disabled = true;
    pauseBtn.disabled = true;
    resumeBtn.disabled = false;
    stopBtn.disabled = false;
  } else {
    startBtn.disabled = false;
    pauseBtn.disabled = true;
    resumeBtn.disabled = true;
    stopBtn.disabled = true;
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
// 6. Language Chips Handler (Auto + One-Tap Fast Override)
// -------------------------------------------------------------

langChips.forEach(chip => {
  chip.addEventListener('click', () => {
    langChips.forEach(c => c.classList.remove('active-chip'));
    chip.classList.add('active-chip');

    const mode = chip.dataset.mode;
    activeMode = mode;

    if (mode === 'auto') {
      // Revert to primary Malayalam as default
      switchRecognitionLanguage(LANG_CONFIG.MALAYALAM.code, true);
      showToast('Switched to Auto-Detect mode (Malayalam primary).', 'info');
    } else {
      switchRecognitionLanguage(mode, true);
      const name = mode === 'ml-IN' ? 'Malayalam' : mode === 'ar-SA' ? 'Arabic' : 'English';
      showToast(`Language set to ${name}.`, 'info');
    }
  });
});

// -------------------------------------------------------------
// 7. Timer System (MM:SS)
// -------------------------------------------------------------

function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    renderTimer();
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function resetTimer() {
  stopTimer();
  elapsedSeconds = 0;
  renderTimer();
}

function renderTimer() {
  const m = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
  const s = String(elapsedSeconds % 60).padStart(2, '0');
  timerDisplay.textContent = `${m}:${s}`;
}

// -------------------------------------------------------------
// 8. Word & Character Counters
// -------------------------------------------------------------

function updateCounters() {
  const text = textEditor.value;

  // Total words: split by whitespace, filter empty tokens
  const words = text.trim().length > 0 ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  totalWordsEl.textContent = words.toLocaleString();

  // Total characters (including spaces)
  totalCharsEl.textContent = text.length.toLocaleString();

  // Total characters (excluding spaces)
  const noSpaces = text.replace(/\s/g, '').length;
  totalCharsNoSpaceEl.textContent = noSpaces.toLocaleString();
}

// Synchronize manual typing in textarea with internal state
textEditor.addEventListener('input', () => {
  finalTranscript = textEditor.value;

  // Auto-detect language script from typed text
  if (activeMode === 'auto') {
    const detected = evaluateSpokenLanguage(finalTranscript);
    if (detected) {
      updateLanguageUI(detected);
    }
  }

  updateCounters();
});

// -------------------------------------------------------------
// 9. Action Buttons (Copy, Download TXT, Clear, Select All)
// -------------------------------------------------------------

// Copy Text
copyBtn.addEventListener('click', async () => {
  const text = textEditor.value.trim();
  if (!text) {
    showToast('There is no text to copy!', 'warning');
    return;
  }

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

// Download TXT
downloadTxtBtn.addEventListener('click', () => {
  const text = textEditor.value.trim();
  if (!text) {
    showToast('Editor is empty. Nothing to download!', 'warning');
    return;
  }

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

// Clear Text
clearBtn.addEventListener('click', () => {
  if (!textEditor.value.trim()) return;

  if (confirm('Are you sure you want to clear the entire text editor?')) {
    textEditor.value = '';
    finalTranscript = '';
    hideInterim();
    resetTimer();
    updateCounters();
    updateLanguageUI(LANG_CONFIG.MALAYALAM);
    showToast('Text editor cleared.', 'info');
  }
});

// Select All
selectAllBtn.addEventListener('click', () => {
  if (!textEditor.value.trim()) {
    showToast('Text editor is empty.', 'info');
    return;
  }
  textEditor.focus();
  textEditor.select();
  showToast('All text selected.', 'info');
});

// -------------------------------------------------------------
// 10. Button Event Listeners
// -------------------------------------------------------------

startBtn.addEventListener('click', () => {
  resetTimer();
  startSession();
});

pauseBtn.addEventListener('click', () => {
  pauseSession();
});

resumeBtn.addEventListener('click', () => {
  resumeSession();
});

stopBtn.addEventListener('click', () => {
  stopSession();
});

// -------------------------------------------------------------
// 11. Keyboard Shortcuts
// -------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  // Ctrl + Enter (or Cmd + Enter): Toggle Start/Resume or Pause
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    if (appState === 'recording') {
      pauseSession();
    } else if (appState === 'paused') {
      resumeSession();
    } else {
      resetTimer();
      startSession();
    }
  }

  // Ctrl + Shift + C (or Cmd + Shift + C): Copy Text
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
    e.preventDefault();
    copyBtn.click();
  }
});

// -------------------------------------------------------------
// 12. Light / Dark Theme Toggle
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
  const isCurrentlyDark = document.documentElement.classList.contains('dark');
  applyTheme(!isCurrentlyDark);
});

// -------------------------------------------------------------
// 13. Bootstrapping
// -------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  // Load saved theme
  const savedTheme = localStorage.getItem('voicetype_theme') || 'light';
  applyTheme(savedTheme === 'dark');

  // Initialize controls & counters
  updateControls();
  updateStatus('ready');
  updateCounters();

  // Initialize language detection with Malayalam as default
  updateLanguageUI(LANG_CONFIG.MALAYALAM);

  // Initialize speech recognition
  recognition = initSpeechRecognition();
});
