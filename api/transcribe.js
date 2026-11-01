/**
 * Vercel Serverless Function — Multilingual Speech Transcription
 *
 * POST /api/transcribe  { audio: <base64>, mimeType: 'audio/webm', languageHint?: 'ml' }
 *   -> { text: '<native script>', language: 'ml' | 'ar' | 'en' | ... }
 *
 * GET  /api/transcribe  -> { configured: boolean, engine: 'whisper-1' }
 *
 * The API key lives ONLY in the server environment (OPENAI_API_KEY).
 * It is never sent to, or readable by, the browser.
 *
 * Whisper performs language identification on the AUDIO itself and always
 * returns the text in the ORIGINAL writing system (Malayalam / Arabic /
 * English). It never transliterates one script into another.
 */

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';
const UPSTREAM_TIMEOUT_MS = 25000;
const MIN_AUDIO_BYTES = 1200; // below this there is nothing transcribable

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Capability probe used by the frontend to decide which engine to run.
  if (req.method === 'GET') {
    return res.status(200).json({
      configured: Boolean(process.env.OPENAI_API_KEY),
      engine: 'whisper-1'
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Frontend falls back to the browser engine when it sees this.
    return res.status(503).json({ error: 'server_asr_not_configured' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (err) {
    return res.status(400).json({ error: 'invalid_json_body' });
  }

  const { audio, mimeType, languageHint } = body;

  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ error: 'missing_audio' });
  }

  let buffer;
  try {
    buffer = Buffer.from(audio, 'base64');
  } catch (err) {
    return res.status(400).json({ error: 'invalid_base64_audio' });
  }

  if (buffer.length < MIN_AUDIO_BYTES) {
    // Too short / pure silence: report empty instead of guessing words.
    return res.status(200).json({ text: '', language: null, skipped: 'too_short' });
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType || 'audio/webm' }), 'chunk.webm');
    form.append('model', 'whisper-1');
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    // Only hint the language when the user explicitly picked one.
    // Omitting it lets Whisper detect the language from the audio.
    if (languageHint) form.append('language', languageHint);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(OPENAI_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      return res.status(502).json({
        error: 'asr_upstream_error',
        status: upstream.status,
        detail: detail.slice(0, 300)
      });
    }

    const data = await upstream.json();

    return res.status(200).json({
      text: typeof data.text === 'string' ? data.text.trim() : '',
      language: data.language || null,
      duration: typeof data.duration === 'number' ? data.duration : null
    });
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? 'asr_timeout' : 'transcription_failed',
      detail: String((err && err.message) || err).slice(0, 300)
    });
  }
}

module.exports = handler;
module.exports.config = {
  api: { bodyParser: { sizeLimit: '6mb' } }
};
