/**
 * VoxScribe Live Engine
 * Real-Time Multilingual Speech-to-Text in Malayalam, Arabic, and English
 * Features: Auto Language Detection, Web Audio Visualizer, Live Streaming,
 *           RTL/LTR dynamic switching, Copying, and Unicode-accurate PDF Export.
 */

// State variables
let recognition = null;
let isRecording = false;
let currentLanguageMode = 'auto'; // 'auto' | 'ml-IN' | 'ar-SA' | 'en-US'
let detectedLanguage = 'en'; // default baseline
let finalTranscript = '';
let interimTranscript = '';
let recordingStartTime = null;
let timerInterval = null;

// Audio context & Visualizer
let audioContext = null;
let analyserNode = null;
let microphoneStream = null;
let animationFrameId = null;

// DOM Elements
const toggleRecordBtn = document.getElementById('toggleRecordBtn');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const micIcon = document.getElementById('micIcon');
const micActionHeading = document.getElementById('micActionHeading');
const micActionSub = document.getElementById('micActionSub');
const timerDisplay = document.getElementById('timerDisplay');
const visualizerCanvas = document.getElementById('visualizerCanvas');
const decibelLevel = document.getElementById('decibelLevel');
const canvasCtx = visualizerCanvas.getContext('2d');

const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const detectedLangBadge = document.getElementById('detectedLangBadge');
const detectedLangText = document.getElementById('detectedLangText');
const wordCountEl = document.getElementById('wordCount');
const charCountEl = document.getElementById('charCount');

const emptyPlaceholder = document.getElementById('emptyPlaceholder');
const transcriptContent = document.getElementById('transcriptContent');
const interimPreview = document.getElementById('interimPreview');
const transcriptScrollContainer = document.getElementById('transcriptScrollContainer');

const clearBtn = document.getElementById('clearBtn');
const copyBtn = document.getElementById('copyBtn');
const copyBtnText = document.getElementById('copyBtnText');
const copyIcon = document.getElementById('copyIcon');
const downloadTxtBtn = document.getElementById('downloadTxtBtn');
const downloadPdfBtn = document.getElementById('downloadPdfBtn');

const langTabs = document.querySelectorAll('.lang-tab');
const mobileLangSelect = document.getElementById('mobileLangSelect');

// Toast Notification Helper
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const toastMsg = document.getElementById('toastMsg');
  const toastIcon = document.getElementById('toastIcon');

  toastMsg.textContent = message;
  
  if (type === 'success') {
    toast.className = 'fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl backdrop-blur-md border border-emerald-500/40 bg-emerald-950/90 text-emerald-200 show';
    toastIcon.setAttribute('data-lucide', 'check-circle');
  } else if (type === 'error') {
    toast.className = 'fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl backdrop-blur-md border border-rose-500/40 bg-rose-950/90 text-rose-200 show';
    toastIcon.setAttribute('data-lucide', 'alert-circle');
  } else {
    toast.className = 'fixed top-5 right-5 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-2xl backdrop-blur-md border border-indigo-500/40 bg-slate-900/90 text-indigo-200 show';
    toastIcon.setAttribute('data-lucide', 'info');
  }
  lucide.createIcons();

  setTimeout(() => {
    toast.classList.remove('show');
  }, 3200);
}

// -------------------------------------------------------------
// 1. Language & Script Detection Engine
// -------------------------------------------------------------

/**
 * Analyzes string content to detect Malayalam, Arabic, or English
 * Malayalam Unicode Range: 0D00–0D7F
 * Arabic Unicode Range: 0600–06FF, 0750–077F, 08A0–08FF, FB50–FDFF, FE70–FEFF
 * Latin Range: A-Za-z
 */
function analyzeLanguageScript(text) {
  if (!text || text.trim().length === 0) return detectedLanguage || 'en';

  const malayalamRegex = /[\u0D00-\u0D7F]/g;
  const arabicRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
  const englishRegex = /[a-zA-Z]/g;

  const mlMatches = (text.match(malayalamRegex) || []).length;
  const arMatches = (text.match(arabicRegex) || []).length;
  const enMatches = (text.match(englishRegex) || []).length;

  if (arMatches > mlMatches && arMatches > enMatches) {
    return 'ar';
  } else if (mlMatches > arMatches && mlMatches > enMatches) {
    return 'ml';
  } else if (enMatches > 0) {
    return 'en';
  }

  return detectedLanguage || 'en';
}

function updateLanguageDisplay(langCode) {
  detectedLanguage = langCode;

  if (langCode === 'ml') {
    detectedLangText.textContent = 'മലയാളം (Malayalam)';
    detectedLangBadge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-950/70 border border-emerald-700/60 text-emerald-300';
    transcriptContent.setAttribute('dir', 'ltr');
    interimPreview.setAttribute('dir', 'ltr');
    transcriptContent.classList.add('font-malayalam');
    transcriptContent.classList.remove('font-arabic');
  } else if (langCode === 'ar') {
    detectedLangText.textContent = 'العربية (Arabic)';
    detectedLangBadge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-950/70 border border-amber-700/60 text-amber-300';
    transcriptContent.setAttribute('dir', 'rtl');
    interimPreview.setAttribute('dir', 'rtl');
    transcriptContent.classList.add('font-arabic');
    transcriptContent.classList.remove('font-malayalam');
  } else {
    detectedLangText.textContent = 'English';
    detectedLangBadge.className = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-sky-950/70 border border-sky-700/60 text-sky-300';
    transcriptContent.setAttribute('dir', 'ltr');
    interimPreview.setAttribute('dir', 'ltr');
    transcriptContent.classList.remove('font-malayalam');
    transcriptContent.classList.remove('font-arabic');
  }
}

// -------------------------------------------------------------
// 2. Web Speech API Recognition Initializer
// -------------------------------------------------------------

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    showToast('Web Speech API is not supported in this browser. Please use Google Chrome or Microsoft Edge.', 'error');
    statusText.textContent = 'Unsupported Browser';
    statusBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-rose-950/80 border border-rose-700/60 text-rose-300';
    return false;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  // Set initial language based on selection
  applyLanguageToRecognition();

  recognition.onstart = () => {
    isRecording = true;
    document.body.classList.add('is-recording');
    statusText.textContent = 'Listening...';
    statusBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-rose-950/80 border border-rose-700/60 text-rose-300';
    
    micActionHeading.textContent = 'Recording Active';
    micActionSub.textContent = 'Listening to your microphone in real time...';
    micIcon.setAttribute('data-lucide', 'square');
    lucide.createIcons();

    if (startBtn) {
      startBtn.disabled = true;
    }
    if (pauseBtn) {
      pauseBtn.disabled = false;
      pauseBtn.classList.remove('opacity-40', 'cursor-not-allowed');
      pauseBtn.classList.add('bg-amber-600', 'text-white', 'hover:bg-amber-500', 'border-amber-500');
      pauseBtn.classList.remove('bg-slate-800', 'text-slate-300');
    }

    startTimer();
  };

  recognition.onresult = (event) => {
    let currentInterim = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      const transcriptPiece = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += (finalTranscript.length > 0 && !finalTranscript.endsWith(' ') ? ' ' : '') + transcriptPiece.trim();
      } else {
        currentInterim += transcriptPiece;
      }
    }

    interimTranscript = currentInterim;

    // Detect language from incoming speech
    const sampleText = (finalTranscript + ' ' + currentInterim).trim();
    if (sampleText.length > 0) {
      const script = analyzeLanguageScript(sampleText);
      updateLanguageDisplay(script);
    }

    renderTranscript();
  };

  recognition.onerror = (event) => {
    console.error('Speech Recognition Error:', event.error);
    if (event.error === 'not-allowed') {
      showToast('Microphone permission was denied. Please allow microphone access in your browser settings.', 'error');
      stopRecording();
    } else if (event.error === 'network') {
      showToast('Network issue with speech recognition engine. Reconnecting...', 'error');
    }
  };

  recognition.onend = () => {
    // If the user hasn't explicitly clicked stop, keep listening (auto-restart keepalive)
    if (isRecording) {
      try {
        recognition.start();
      } catch (e) {
        console.warn('Re-start triggered automatically:', e);
      }
    } else {
      stopRecordingUI();
    }
  };

  return true;
}

function applyLanguageToRecognition() {
  if (!recognition) return;

  if (currentLanguageMode === 'auto') {
    // In auto mode, default to multi-lingual / current detected language
    if (detectedLanguage === 'ml') {
      recognition.lang = 'ml-IN';
    } else if (detectedLanguage === 'ar') {
      recognition.lang = 'ar-SA';
    } else {
      recognition.lang = 'en-US';
    }
  } else {
    recognition.lang = currentLanguageMode;
  }
}

// -------------------------------------------------------------
// 3. Audio Visualizer (Web Audio API)
// -------------------------------------------------------------

async function startAudioStream() {
  try {
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 64;
    
    const source = audioContext.createMediaStreamSource(microphoneStream);
    source.connect(analyserNode);

    drawVisualizer();
  } catch (err) {
    console.error('Microphone Access Error:', err);
    showToast('Unable to access microphone. Please check permissions.', 'error');
    stopRecording();
  }
}

function stopAudioStream() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  if (microphoneStream) {
    microphoneStream.getTracks().forEach(track => track.stop());
    microphoneStream = null;
  }
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
    audioContext = null;
  }
  drawIdleVisualizer();
}

function drawVisualizer() {
  if (!analyserNode) return;

  const bufferLength = analyserNode.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  const draw = () => {
    animationFrameId = requestAnimationFrame(draw);
    analyserNode.getByteFrequencyData(dataArray);

    const width = visualizerCanvas.width;
    const height = visualizerCanvas.height;
    canvasCtx.clearRect(0, 0, width, height);

    let sum = 0;
    const barCount = bufferLength;
    const barWidth = (width / barCount) - 2;

    for (let i = 0; i < barCount; i++) {
      const barHeight = (dataArray[i] / 255) * height;
      sum += dataArray[i];

      // Dynamic color gradient based on frequency
      const hue = 240 + (i / barCount) * 60; // Indigo to purple gradient
      canvasCtx.fillStyle = `hsl(${hue}, 85%, 60%)`;
      canvasCtx.shadowBlur = 6;
      canvasCtx.shadowColor = `hsl(${hue}, 85%, 50%)`;

      const x = i * (barWidth + 2);
      const y = height - barHeight;

      // Draw rounded bar
      canvasCtx.beginPath();
      canvasCtx.roundRect(x, y, barWidth, barHeight, [2, 2, 0, 0]);
      canvasCtx.fill();
    }

    // Calculate approximate RMS / decibels
    const average = sum / barCount;
    if (average > 2) {
      const db = Math.round(20 * Math.log10(average / 255));
      decibelLevel.textContent = `${db} dB`;
      decibelLevel.className = 'text-emerald-400 font-mono';
    } else {
      decibelLevel.textContent = '-∞ dB';
      decibelLevel.className = 'text-slate-500 font-mono';
    }
  };

  draw();
}

function drawIdleVisualizer() {
  const width = visualizerCanvas.width;
  const height = visualizerCanvas.height;
  canvasCtx.clearRect(0, 0, width, height);

  // Draw flat subtle center line
  canvasCtx.strokeStyle = 'rgba(99, 102, 241, 0.2)';
  canvasCtx.lineWidth = 2;
  canvasCtx.beginPath();
  canvasCtx.moveTo(0, height / 2);
  canvasCtx.lineTo(width, height / 2);
  canvasCtx.stroke();

  decibelLevel.textContent = '-∞ dB';
  decibelLevel.className = 'text-slate-500 font-mono';
}

// -------------------------------------------------------------
// 4. Recording Controls & Timer
// -------------------------------------------------------------

async function startRecording() {
  if (!recognition) {
    const initialized = initSpeechRecognition();
    if (!initialized) return;
  }

  try {
    await startAudioStream();
    recognition.start();
  } catch (err) {
    console.error('Error starting recognition:', err);
  }
}

function stopRecording() {
  isRecording = false;
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {
      console.warn(e);
    }
  }
  stopAudioStream();
  stopRecordingUI();
}

function stopRecordingUI() {
  document.body.classList.remove('is-recording');
  statusText.textContent = 'Paused / Ready';
  statusBadge.className = 'flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-slate-800/80 border border-slate-700/60 text-slate-300';
  
  micActionHeading.textContent = 'Click to Resume Recording';
  micActionSub.textContent = 'Press Start or Mic to continue speaking';
  micIcon.setAttribute('data-lucide', 'mic');
  lucide.createIcons();

  if (startBtn) {
    startBtn.disabled = false;
  }
  if (pauseBtn) {
    pauseBtn.disabled = true;
    pauseBtn.classList.add('opacity-40', 'cursor-not-allowed');
    pauseBtn.classList.remove('bg-amber-600', 'text-white', 'hover:bg-amber-500', 'border-amber-500');
    pauseBtn.classList.add('bg-slate-800', 'text-slate-300');
  }

  stopTimer();
}

function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

function startTimer() {
  stopTimer();
  recordingStartTime = Date.now();
  timerInterval = setInterval(() => {
    const elapsedSeconds = Math.floor((Date.now() - recordingStartTime) / 1000);
    const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, '0');
    const seconds = String(elapsedSeconds % 60).padStart(2, '0');
    timerDisplay.textContent = `${minutes}:${seconds}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// -------------------------------------------------------------
// 5. Transcript Rendering & Sync
// -------------------------------------------------------------

function renderTranscript() {
  const hasText = (finalTranscript.trim().length > 0) || (interimTranscript.trim().length > 0);

  if (hasText) {
    emptyPlaceholder.classList.add('hidden');
    transcriptContent.classList.remove('hidden');
  } else {
    emptyPlaceholder.classList.remove('hidden');
    transcriptContent.classList.add('hidden');
    interimPreview.classList.add('hidden');
  }

  // Set the finalized text inside editable container
  // Only update innerText if not focused to avoid messing up manual cursor placement
  if (document.activeElement !== transcriptContent) {
    transcriptContent.innerText = finalTranscript;
  }

  // Display interim stream preview
  if (interimTranscript.trim().length > 0) {
    interimPreview.classList.remove('hidden');
    interimPreview.textContent = interimTranscript + ' ❚';
  } else {
    interimPreview.classList.add('hidden');
    interimPreview.textContent = '';
  }

  // Auto-scroll to bottom of container
  transcriptScrollContainer.scrollTop = transcriptScrollContainer.scrollHeight;

  // Update counts
  updateStats();
}

function updateStats() {
  const currentTotal = (transcriptContent.innerText || finalTranscript).trim();
  charCountEl.textContent = currentTotal.length;
  
  const words = currentTotal.length > 0 ? currentTotal.split(/\s+/).filter(Boolean).length : 0;
  wordCountEl.textContent = words;
}

// Sync edits made directly in contenteditable element
transcriptContent.addEventListener('input', () => {
  finalTranscript = transcriptContent.innerText;
  const script = analyzeLanguageScript(finalTranscript);
  updateLanguageDisplay(script);
  updateStats();
});

// -------------------------------------------------------------
// 6. Action Handlers (Copy, Clear, Download PDF)
// -------------------------------------------------------------

// Copy to Clipboard
copyBtn.addEventListener('click', async () => {
  const text = (transcriptContent.innerText || finalTranscript).trim();
  if (!text) {
    showToast('There is no transcript text to copy!', 'warning');
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    copyBtnText.textContent = 'Copied to Clipboard!';
    copyIcon.setAttribute('data-lucide', 'check');
    copyBtn.classList.add('bg-emerald-600', 'text-white', 'border-emerald-500');
    lucide.createIcons();

    showToast('Transcript copied to clipboard!', 'success');

    setTimeout(() => {
      copyBtnText.textContent = 'Copy to Clipboard';
      copyIcon.setAttribute('data-lucide', 'copy');
      copyBtn.classList.remove('bg-emerald-600', 'text-white', 'border-emerald-500');
      lucide.createIcons();
    }, 2200);
  } catch (err) {
    console.error('Failed to copy: ', err);
    showToast('Failed to copy to clipboard.', 'error');
  }
});

// Download as .TXT File
if (downloadTxtBtn) {
  downloadTxtBtn.addEventListener('click', () => {
    const text = (transcriptContent.innerText || finalTranscript).trim();
    if (!text) {
      showToast('There is no transcript text to download!', 'warning');
      return;
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
    const filename = `transcript_${dateStr}_${timeStr}.txt`;

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);

    showToast('Downloaded .txt transcript successfully!', 'success');
  });
}

// Clear Transcript
clearBtn.addEventListener('click', () => {
  const text = (transcriptContent.innerText || finalTranscript).trim();
  if (!text) return;

  if (confirm('Are you sure you want to clear the transcript?')) {
    finalTranscript = '';
    interimTranscript = '';
    transcriptContent.innerText = '';
    interimPreview.innerText = '';
    updateLanguageDisplay('en');
    renderTranscript();
    timerDisplay.textContent = '00:00';
    showToast('Transcript cleared.', 'info');
  }
});

// Download as PDF (Guaranteed Unicode accuracy for Arabic & Malayalam)
downloadPdfBtn.addEventListener('click', () => {
  const text = (transcriptContent.innerText || finalTranscript).trim();
  if (!text) {
    showToast('No transcript available to download as PDF.', 'warning');
    return;
  }

  downloadPdfBtn.disabled = true;
  downloadPdfBtn.innerHTML = `<span class="inline-block animate-spin mr-1">◌</span> Exporting PDF...`;

  try {
    const pdfTemplate = document.getElementById('pdfExportTemplate');
    const pdfTranscriptContent = document.getElementById('pdfTranscriptContent');
    const pdfDate = document.getElementById('pdfDate');
    const pdfLang = document.getElementById('pdfLang');
    const pdfStats = document.getElementById('pdfStats');

    // Populate metadata
    const now = new Date();
    pdfDate.textContent = now.toLocaleDateString() + ' ' + now.toLocaleTimeString();
    
    let langLabel = 'English';
    if (detectedLanguage === 'ml') langLabel = 'Malayalam (മലയാളം)';
    if (detectedLanguage === 'ar') langLabel = 'Arabic (العربية)';
    pdfLang.textContent = langLabel;

    pdfTranscriptContent.textContent = text;
    
    // Set proper script direction and font for the PDF document
    if (detectedLanguage === 'ar') {
      pdfTranscriptContent.setAttribute('dir', 'rtl');
      pdfTranscriptContent.style.textAlign = 'right';
      pdfTranscriptContent.style.fontFamily = "'Noto Sans Arabic', Tahoma, sans-serif";
    } else if (detectedLanguage === 'ml') {
      pdfTranscriptContent.setAttribute('dir', 'ltr');
      pdfTranscriptContent.style.textAlign = 'left';
      pdfTranscriptContent.style.fontFamily = "'Noto Sans Malayalam', sans-serif";
    } else {
      pdfTranscriptContent.setAttribute('dir', 'ltr');
      pdfTranscriptContent.style.textAlign = 'left';
      pdfTranscriptContent.style.fontFamily = "'Inter', sans-serif";
    }

    const words = text.split(/\s+/).filter(Boolean).length;
    pdfStats.textContent = `Words: ${words} | Characters: ${text.length}`;

    // PDF Export Options
    const opt = {
      margin:       [12, 12, 12, 12],
      filename:     `VoxScribe_Transcript_${now.toISOString().slice(0, 10)}.pdf`,
      image:        { type: 'jpeg', quality: 0.98 },
      html2canvas:  { scale: 2, useCORS: true, logging: false },
      jsPDF:        { unit: 'mm', format: 'a4', orientation: 'portrait' }
    };

    html2pdf().set(opt).from(pdfTemplate).save().then(() => {
      showToast('PDF downloaded successfully!', 'success');
      resetPdfButton();
    }).catch(err => {
      console.error('PDF Generation Error:', err);
      showToast('Error generating PDF.', 'error');
      resetPdfButton();
    });

  } catch (error) {
    console.error('PDF error:', error);
    showToast('Failed to generate PDF.', 'error');
    resetPdfButton();
  }
});

function resetPdfButton() {
  downloadPdfBtn.disabled = false;
  downloadPdfBtn.innerHTML = `<i data-lucide="download" class="w-3.5 h-3.5"></i><span>Download PDF</span>`;
  lucide.createIcons();
}

// -------------------------------------------------------------
// 7. Language Switcher Tabs
// -------------------------------------------------------------

function setLanguageMode(mode) {
  currentLanguageMode = mode;

  langTabs.forEach(tab => {
    if (tab.dataset.lang === mode) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  if (mobileLangSelect) {
    mobileLangSelect.value = mode;
  }

  if (mode === 'auto') {
    showToast('Switched to Auto-Detect mode.', 'info');
  } else if (mode === 'ml-IN') {
    updateLanguageDisplay('ml');
    showToast('Language set to Malayalam.', 'info');
  } else if (mode === 'ar-SA') {
    updateLanguageDisplay('ar');
    showToast('Language set to Arabic.', 'info');
  } else if (mode === 'en-US') {
    updateLanguageDisplay('en');
    showToast('Language set to English.', 'info');
  }

  applyLanguageToRecognition();

  // If currently recording, restart recognition seamlessly to apply new language model
  if (isRecording && recognition) {
    try {
      recognition.stop();
    } catch (e) {}
  }
}

langTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    setLanguageMode(tab.dataset.lang);
  });
});

if (mobileLangSelect) {
  mobileLangSelect.addEventListener('change', (e) => {
    setLanguageMode(e.target.value);
  });
}

// -------------------------------------------------------------
// 8. Event Listeners & Bootstrapping
// -------------------------------------------------------------

toggleRecordBtn.addEventListener('click', toggleRecording);

if (startBtn) {
  startBtn.addEventListener('click', () => {
    if (!isRecording) {
      startRecording();
    }
  });
}

if (pauseBtn) {
  pauseBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
      showToast('Recording paused.', 'info');
    }
  });
}

// Initialize icons and visualizer on page load
window.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  drawIdleVisualizer();
  initSpeechRecognition();
  updateLanguageDisplay('en');
});

