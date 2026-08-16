import { Platform } from 'react-native';

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      audioCtx = new Ctor();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function playTone(freq: number, delaySec: number, durationSec: number) {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    const t0 = ctx.currentTime + delaySec;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationSec);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durationSec + 0.05);
  } catch {
    return;
  }
}

export function playNewOrderSound(ringtone: 'beep' | 'melody' | 'none', voiceAnnounce: boolean) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  try {
    if (ringtone === 'beep') {
      playTone(880, 0, 0.15);
    } else if (ringtone === 'melody') {
      playTone(660, 0, 0.12);
      playTone(990, 0.08, 0.12);
    }
    if (voiceAnnounce && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance('New order, please accept'));
    }
  } catch {
    return;
  }
}

export function stopNewOrderSound() {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  try {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  } catch {
    return;
  }
}
