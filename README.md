# 🎙️ VoiceType – Live Speech to Text

A modern, professional, fully responsive web application that captures live microphone audio and converts spoken words into editable text in real time with **Zero-Duplication Result Processing** and **Intelligent Multilingual Support** across **Malayalam**, **Arabic**, and **English**.

---

## ⚡ Zero-Duplication Architecture

The result-handling logic uses a clean **Session Memory Model**:
- **`persistedTranscript`:** Holds all text committed from previous recognition sessions or typed manually by the user.
- **`sessionFinal`:** Reconstructed directly from `event.results` in the current active session. Each finalized phrase is counted exactly **once**, eliminating cumulative loops (`"Hello Hello Hello Hello"`).
- **`sessionInterim`:** Real-time temporary in-flight speech displayed dynamically without permanent commitment.
- When an utterance finalizes, it seamlessly transitions into the transcript without re-appending previous phrases.
- When recognition pauses, resumes, or auto-reconnects, previous text is preserved 100% and new speech is added cleanly.

---

## 🌐 Multi-Language Support

- **🟢 Malayalam (`ml-IN`) – Default & Highest Priority:**
  - High-precision transcription with authentic Brahmic conjuncts (കൂട്ടക്ഷരങ്ങൾ) and chillu characters (ചില്ലക്ഷരങ്ങൾ).
- **🟡 Arabic (`ar-SA`) – Secondary Priority:**
  - Full cursive letter joining with bidirectional layout (`dir="auto"`).
- **🔵 English (`en-US`) – Tertiary Priority:**
  - Standard Latin phonetics and punctuation.

---

## 🛠️ Complete Feature Set

- **Controls:** Start, Pause, Resume, and Stop with session continuity.
- **Editable Text Box:** Click anywhere to manually edit, type, insert punctuation, or delete text.
- **Live Statistics:**
  - Total Words
  - Total Characters
  - Total Characters (excluding spaces)
- **Productivity Toolbar:**
  - **Copy Text:** One-click clipboard copy with visual feedback (`Ctrl + Shift + C`).
  - **Download TXT:** Instant download as a clean timestamped `.txt` document.
  - **Select All:** One-click selection of the full transcript.
  - **Clear Text:** Safely clears the editor after user confirmation.
- **Diagnostic Debug Panel:** Real-time visibility into the on-device engine (browser support, microphone permission, engine status, audio capture, VAD speech detection, detected language, transcribed segments, last error).
- **Timer:** Real-time speaking duration in `MM:SS`.
- **Theme:** Professional light theme by default with a dark mode toggle (`localStorage` persisted).

---

## 🚀 How to Run Locally

### Option 1: 1-Click Server Launcher (Recommended)
Double-click **`start-server.bat`** in this folder. It opens `http://localhost:5000/` automatically in your default browser.

### Option 2: Direct Open
Double-click **`index.html`** in **Google Chrome**, **Microsoft Edge**, or **Brave**.
