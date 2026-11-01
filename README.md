# 🎙️ VoiceType – Live Speech to Text

A modern, professional, fully responsive web application that captures live microphone audio and converts spoken words into editable text in real time using the browser's native **Web Speech API** (`webkitSpeechRecognition` / `SpeechRecognition`).

---

## ✨ Key Features

### 1. Speech Recognition Lifecycle
- **▶ Start Button:** Requests microphone permission and begins live transcription.
- **⏸ Pause Button:** Temporarily halts recognition while safely preserving all previously transcribed text.
- **⏯ Resume Button:** Continues transcription right where you left off without any duplicated text.
- **⏹ Stop Button:** Completely stops the current recording session.
- **🔴 Pulsing Recording Indicator:** Subtle animated pulsing red dot indicating active listening.
- **⚡ Zero Duplication Engine:** Finalized phrases and real-time interim speech are handled separately to guarantee text is never duplicated.

### 2. Multi-Language Support
- **English (US)** (`en-US`) – *Default*
- **English (UK)** (`en-GB`)
- **Malayalam (India)** (`ml-IN`) – Complex ligatures and conjunct support
- **Arabic (Saudi Arabia)** (`ar-SA`) – Automatic **Right-to-Left (RTL)** text alignment
- **Hindi (India)** (`hi-IN`)
- **Urdu (Pakistan)** (`ur-PK`) – Automatic **Right-to-Left (RTL)** text alignment
- **Tamil (India)** (`ta-IN`)

### 3. Editable Text Editor & Real-Time Counters
- **Full Text Editing:** Click anywhere to manually edit, type, insert punctuation, or delete text.
- **Live Statistics:**
  - **Total Words:** Count of words in real time.
  - **Total Characters:** Total character count including spaces.
  - **Total Characters (excluding spaces):** Exact non-whitespace character count.
  - Automatically updates as speech streams in or when manually edited.

### 4. Action Toolbar & Productivity
- **📋 Copy Text:** One-click clipboard copy with animated feedback (`Ctrl + Shift + C`).
- **📥 Download TXT:** Instant download as a clean timestamped `.txt` document.
- **🗑️ Clear Text:** Safely clears the editor after user confirmation.
- **☑️ Select All:** One-click selection of the full transcript.
- **⏱️ Timer:** Displays elapsed speaking duration in `MM:SS` format.
- **🌓 Light / Dark Mode:** Professional light theme by default with seamless toggle to dark mode.

### 5. Keyboard Shortcuts
| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd> + <kbd>Enter</kbd> (or <kbd>Cmd</kbd> + <kbd>Enter</kbd>) | **Start** / **Resume** / **Pause** recording |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>C</kbd> | **Copy** text to clipboard |

### 6. Privacy & Security
> **Privacy Notice:** Your microphone audio is processed through browser speech recognition. This application does not intentionally store or transmit your audio to external servers.

---

## 🚀 How to Run Locally

### Option 1: 1-Click Server Launcher (Recommended)
1. Double-click **`start-server.bat`** in this folder.
2. It launches a local server at **`http://localhost:5000/`** and opens your default browser automatically.

### Option 2: Direct Browser Open
Double-click **`index.html`** to open it directly in **Google Chrome**, **Microsoft Edge**, or **Brave**.

---

## 🛠️ Technology Stack
- **Architecture:** HTML5, CSS3, Vanilla JavaScript (ES6+)
- **Styling:** Tailwind CSS (Light / Dark mode, centered 900px responsive layout)
- **Icons:** Lucide Icons
- **Speech Engine:** Web Speech API (`webkitSpeechRecognition` / `SpeechRecognition`)
- **Typography:** Google Fonts (`Inter`, `Noto Sans Malayalam`, `Noto Sans Arabic`)
- **File Export:** Client-side Blob API & Object URL
