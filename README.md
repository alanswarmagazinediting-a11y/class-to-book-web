# 🎙️ VoxScribe Live - Real-Time Multilingual Speech-to-Text

A modern, responsive web application for real-time speech-to-text transcription in **Malayalam**, **Arabic**, and **English** with automatic script/language detection, live audio visualizer, dynamic text direction (RTL/LTR), one-click clipboard copying, and high-fidelity PDF export.

---

## ✨ Features

- **🔴 Start / Pause Controls:** Dedicated buttons to easily start recording and pause transcription at any time, plus quick-mic toggle.
- **⚡ Real-Time Streaming Text:** Displays interim/provisional speech live as you speak, seamlessly committing finalized phrases.
- **✏️ Editable Text Box:** Click directly into the transcript box at any time to fix typos, add punctuation, or modify transcribed text in real time.
- **🔢 Real-Time Word Counter:** Live word and character counting that updates dynamically as you speak or edit.
- **📋 Copy to Clipboard:** One-click copy with instant visual checkmark feedback and toast notification.
- **💾 Download Options:**
  - **Download .TXT:** Instant download of clean plain-text transcripts (`.txt`).
  - **Download PDF:** High-fidelity Unicode PDF export preserving Arabic RTL and Malayalam ligatures.
- **🌐 Automatic Language Understanding:**
  - **Malayalam (`ml-IN`):** Supports complex conjuncts (കൂട്ടക്ഷരങ്ങൾ) and chillu characters (ചില്ലക്ഷരങ്ങൾ).
  - **Arabic (`ar-SA`):** Automatically triggers **Right-to-Left (`dir="rtl"`)** alignment and cursive Arabic shaping.
  - **English (`en-US`):** High-accuracy real-time punctuation and phonetics.
- **📊 Live Audio Visualizer:** Dynamic frequency bar visualizer with real-time decibel level metering.
- **🚀 Zero Installation Needed:** Built with modern web standards and standalone zero-dependency architecture. Runs on any modern browser (Chrome, Edge, Safari, Brave).

---

## 🚀 How to Run the Application

### Option 1: Quick Launcher (Recommended)
1. Double-click **`start-server.bat`** in this folder.
2. It starts a lightweight local server on `http://localhost:5000` and opens your default browser automatically.
3. Allow microphone permission when prompted.

### Option 2: Direct Browser Open
Simply double-click **`index.html`** to open it directly in **Google Chrome**, **Microsoft Edge**, or **Brave**.

---

## 🛠️ Technology Stack

| Layer | Technology |
|---|---|
| **Frontend Framework** | HTML5 / Modern ES6+ JavaScript |
| **Styling & UI** | Tailwind CSS (Dark/Glassmorphism theme) |
| **Icons** | Lucide Icons |
| **Speech Engine** | Web Speech API (`webkitSpeechRecognition`) |
| **Audio Processing** | Web Audio API (`AudioContext`, `AnalyserNode`) |
| **Typography** | Google Fonts (`Noto Sans Malayalam`, `Noto Sans Arabic`, `Inter`) |
| **PDF Generation** | `html2pdf.js` + `html2canvas` (with 2x retina scale for crystal-clear complex fonts) |

---

## 🔒 Privacy
All speech recognition and processing runs locally in your browser. No audio recordings are stored on any server.

