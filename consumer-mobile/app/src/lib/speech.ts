/* Web Speech API voice-input wrapper — the single seam between the search
 * mic button and the browser's SpeechRecognition. Web-only (the demo runs on
 * the web; native devices have no SpeechRecognition and get VOICE_UNSUPPORTED
 * — the UI falls back to typing). Node-safe by construction: `window` is
 * guarded, so importing this module in the node test bundle and calling
 * startVoiceInput resolves VOICE_UNSUPPORTED without touching any browser
 * API. No new npm packages — `window.SpeechRecognition || webkitSpeechRecognition`
 * is a browser global where it exists.
 *
 * The DOM lib does not type SpeechRecognition (still a draft API), so the
 * minimal surface the wrapper touches is declared structurally here.
 */
export type VoiceInputError = 'VOICE_UNSUPPORTED' | 'VOICE_PERMISSION_DENIED' | 'VOICE_NO_SPEECH' | 'VOICE_FAILED';

export type VoiceInputResult =
  | { ok: true }
  | { ok: false; error: VoiceInputError };

/** Structural subset of the (draft) SpeechRecognition API. */
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: { results: { [index: number]: { [index: number]: { transcript: string } } } }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

/** Hard stop after this long so the listening state never hangs (the browser
 * usually fires no-speech long before, but a hung recognizer must not block
 * the UI forever). */
const MAX_LISTEN_MS = 15000;

function createRecognition(): SpeechRecognitionLike | null {
  try {
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
}

/** Start listening once. Every final transcript fires `onTranscript`; the
 * returned promise settles when recognition ends (result → auto-stop, error,
 * or the watchdog). When speech is unavailable anywhere (node, native, or a
 * browser without SpeechRecognition) it resolves VOICE_UNSUPPORTED
 * immediately — never throws. */
export async function startVoiceInput(onTranscript: (text: string) => void): Promise<VoiceInputResult> {
  const rec = createRecognition();
  if (!rec) return { ok: false, error: 'VOICE_UNSUPPORTED' };

  return new Promise<VoiceInputResult>((resolve) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: VoiceInputResult) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
      resolve(result);
    };

    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript;
      if (transcript) onTranscript(transcript.trim());
    };
    rec.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        finish({ ok: false, error: 'VOICE_PERMISSION_DENIED' });
      } else if (event.error === 'no-speech') {
        finish({ ok: false, error: 'VOICE_NO_SPEECH' });
      } else {
        finish({ ok: false, error: 'VOICE_FAILED' });
      }
    };
    // onend fires after a clean stop (transcript received) and after errors —
    // finish() is idempotent, so the first resolution wins.
    rec.onend = () => finish({ ok: true });
    watchdog = setTimeout(() => finish({ ok: false, error: 'VOICE_NO_SPEECH' }), MAX_LISTEN_MS);

    try {
      rec.start();
    } catch {
      finish({ ok: false, error: 'VOICE_FAILED' });
    }
  });
}
