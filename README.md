# 🎙️ VoiceType – Live Speech to Text (Automatic Language Detection)

A modern, professional, fully responsive web application that captures live microphone audio and converts spoken words into editable text in real time with **Intelligent Automatic Language Detection** across **Malayalam**, **Arabic**, and **English**.

---

## ✨ Automatic Language Detection Architecture

The application removes manual language dropdowns and replaces them with an adaptive multi-language detection engine:

### 1. Priority Hierarchy
- **🟢 Malayalam (`ml-IN`) – Primary & Default (Highest Priority):**
  - Starts listening in Malayalam by default.
  - Generates authentic Malayalam script (മലയാളം) with full conjunct (കൂട്ടക്ഷരങ്ങൾ) and chillu (ചില്ലക്ഷരങ്ങൾ) ligatures.
- **🟡 Arabic (`ar-SA`) – Secondary:**
  - Generates authentic Arabic script (العربية) with native bidirectional layout (`dir="auto"` / RTL).
- **🔵 English (`en-US`) – Tertiary:**
  - Generates English Latin script.

### 2. Intelligent Hysteresis Controller (Loanword Filter)
- In natural Malayalam speech, speakers frequently use English loanwords (e.g., *"bus"*, *"class"*, *"time"*, *"school"*, *"hospital"*, *"phone"*, *"meeting"*).
- The Hysteresis Controller prevents erratic language switching: an isolated English word inside Malayalam speech does **not** trigger a language switch.
- The system only transitions to English when a sustained phrase (3+ consecutive English tokens) is spoken without Malayalam context.
- Malayalam retains highest priority: any Malayalam utterance immediately re-locks the engine into Malayalam.

### 3. Continuous Recognition & Zero Data Loss
- When the detected language changes, previously transcribed text is safely retained in the editor.
- The status pill dynamically updates in real time:
  - `🟢 Detected: Malayalam (Primary)`
  - `🟡 Detected: Arabic (Secondary)`
  - `🔵 Detected: English (Tertiary)`

---

## 🛠️ Complete Feature Set

- **Controls:** Start, Pause, Resume, and Stop with full session state management.
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
- **Timer:** Real-time speaking duration in `MM:SS`.
- **Theme:** Professional light theme by default with a dark mode toggle (`localStorage` persisted).
- **Shortcuts:**
  - <kbd>Ctrl</kbd> + <kbd>Enter</kbd>: Start, Resume, or Pause recording.
  - <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>C</kbd>: Copy text.

---

## 🚀 How to Run Locally

### Option 1: 1-Click Server Launcher
Double-click **`start-server.bat`** in this folder. It opens `http://localhost:5000/` automatically in your default browser.

### Option 2: Direct Open
Double-click **`index.html`** in **Google Chrome**, **Microsoft Edge**, or **Brave**.
