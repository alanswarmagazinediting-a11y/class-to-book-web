/**
 * VoiceType – Live Speech to Text
 * Pure Vanilla JavaScript implementation of Web Speech API
 * Features: Start, Pause, Resume, Stop, Multi-Language, Live Word/Char Counters,
 *           TXT Download, Clipboard Copy, Keyboard Shortcuts & Dark Mode.
 */

// State Management
let recognition = null;
let appState = 'idle'; // 'idle' | 'recording' | 'paused' | 'stopped'
let finalTranscript = '';
let interimTranscript = '';
let isIntentionalStop = false;

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

const languageSelect = document.getElementById('languageSelect');
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
  }, 2600);
}

// -------------------------------------------------------------
// 2. Web Speech API Initialization & Lifecycle
// -------------------------------------------------------------
function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    if (unsupportedAlert) unsupportedAlert.classList.remove('hidden');
    startBtn.disabled = true;
    updateStatus('unsupported');
    return null;
  }

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.lang = languageSelect.value || 'en-US';

  rec.onstart = () => {
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
        // Append finalized text with proper spacing
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
      interimStream.classList.remove('hidden');
      interimText.textContent = interimTranscript;
    } else {
      interimStream.classList.add('hidden');
      interimText.textContent = '';
    }
  };

  rec.onerror = (event) => {
    console.warn('Speech recognition error:', event.error);

    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      showToast('Microphone access denied. Please allow microphone permission.', 'error');
      stopSession();
    } else if (event.error === 'no-speech') {
      // Benign silence timeout - keep listening if still in recording state
    } else if (event.error === 'network') {
      showToast('Network issue with speech recognition engine.', 'warning');
    }
  };

  rec.onend = () => {
    // If not intentionally stopped or paused, automatically restart to maintain session
    if (appState === 'recording' && !isIntentionalStop) {
      try {
        rec.start();
      } catch (err) {
        console.warn('Auto-restart notice:', err);
      }
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
// 3. Audio & Session Controls (Start, Pause, Resume, Stop)
// -------------------------------------------------------------

function startSession() {
  if (!recognition) {
    recognition = initSpeechRecognition();
    if (!recognition) return;
  }

  isIntentionalStop = false;
  recognition.lang = languageSelect.value;
  applyTextDirection(languageSelect.value);

  try {
    recognition.start();
    showToast('Microphone active. Listening...', 'info');
  } catch (err) {
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
  showToast('Recording paused. Existing text preserved.', 'info');
}

function resumeSession() {
  if (appState !== 'paused') return;

  isIntentionalStop = false;
  recognition.lang = languageSelect.value;
  applyTextDirection(languageSelect.value);

  try {
    recognition.start();
    appState = 'recording';
    updateControls();
    updateStatus('listening');
    startTimer();
    showToast('Resuming recording...', 'info');
  } catch (err) {
    console.warn('Resume error:', err);
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
// 4. Status Indicator & Button States
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
    // 'idle' or 'stopped'
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
// 5. Timer System (MM:SS)
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
// 6. Language Selection & Text Direction
// -------------------------------------------------------------

function applyTextDirection(langCode) {
  // RTL languages: Arabic (ar-SA), Urdu (ur-PK)
  if (langCode === 'ar-SA' || langCode === 'ur-PK') {
    textEditor.setAttribute('dir', 'rtl');
    interimStream.setAttribute('dir', 'rtl');
    textEditor.classList.add('font-arabic');
    textEditor.classList.remove('font-malayalam');
  } else if (langCode === 'ml-IN') {
    textEditor.setAttribute('dir', 'ltr');
    interimStream.setAttribute('dir', 'ltr');
    textEditor.classList.add('font-malayalam');
    textEditor.classList.remove('font-arabic');
  } else {
    textEditor.setAttribute('dir', 'ltr');
    interimStream.setAttribute('dir', 'ltr');
    textEditor.classList.remove('font-malayalam', 'font-arabic');
  }
}

languageSelect.addEventListener('change', () => {
  const selectedLang = languageSelect.value;
  applyTextDirection(selectedLang);

  if (recognition) {
    recognition.lang = selectedLang;
    // If currently recording, restart seamlessly to switch the acoustic/language model
    if (appState === 'recording') {
      try {
        recognition.stop();
      } catch (e) {}
    }
  }

  showToast(`Language set to ${languageSelect.options[languageSelect.selectedIndex].text}`, 'info');
});

// -------------------------------------------------------------
// 7. Word & Character Counters
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
  updateCounters();
});

// -------------------------------------------------------------
// 8. Action Buttons (Copy, Download TXT, Clear, Select All)
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
// 9. Button Event Listeners
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
// 10. Keyboard Shortcuts
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
// 11. Light / Dark Theme Toggle
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
// 12. Bootstrapping
// -------------------------------------------------------------

window.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();

  // Load saved theme (default to light mode as requested in specifications)
  const savedTheme = localStorage.getItem('voicetype_theme') || 'light';
  applyTheme(savedTheme === 'dark');

  // Set initial language & direction
  applyTextDirection(languageSelect.value);

  // Initialize controls & counters
  updateControls();
  updateStatus('ready');
  updateCounters();

  // Pre-initialize speech recognition
  recognition = initSpeechRecognition();
});
