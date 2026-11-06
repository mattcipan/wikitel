// Visite guidée : lecture de l'article avec la synthèse vocale du navigateur.
// `pause()` est peu fiable sur Android, donc on annule et on reprend au début du morceau en cours.
const synth = window.speechSynthesis;

export const speechSupported = () => Boolean(synth && window.SpeechSynthesisUtterance);

export function voicesFor(lang) {
  if (!speechSupported()) return [];
  return synth.getVoices().filter((v) => v.lang.toLowerCase().replace('_', '-').startsWith(lang));
}

// Les voix arrivent parfois après le chargement de la page.
export function onVoicesReady(callback) {
  if (speechSupported()) synth.addEventListener?.('voiceschanged', callback);
}

function preferredVoice(lang, savedUri) {
  const voices = voicesFor(lang);
  return voices.find((v) => v.voiceURI === savedUri)
    ?? voices.find((v) => /premium|enhanced|natural|neural/i.test(v.name))
    ?? voices.find((v) => v.default)
    ?? voices[0]
    ?? null;
}

export class Narrator {
  constructor({ chunks, lang, start = 0, getOptions, onChange }) {
    Object.assign(this, { chunks, lang, index: start, getOptions, onChange });
    this.state = 'idle';
    this.generation = 0;
    this.wakeLock = null;
    this.onVisible = () => { if (document.visibilityState === 'visible' && this.state === 'playing') this.keepAwake(); };
    document.addEventListener('visibilitychange', this.onVisible);
  }

  emit() {
    this.onChange(this);
  }

  async keepAwake() {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      this.wakeLock = null;
    }
  }

  releaseAwake() {
    this.wakeLock?.release?.().catch(() => {});
    this.wakeLock = null;
  }

  speakCurrent() {
    const generation = ++this.generation;
    const { rate, voiceUri } = this.getOptions();
    const utterance = new SpeechSynthesisUtterance(this.chunks[this.index].text);
    const voice = preferredVoice(this.lang, voiceUri);
    utterance.lang = voice?.lang ?? this.lang;
    if (voice) utterance.voice = voice;
    utterance.rate = rate;
    utterance.onend = () => {
      if (generation !== this.generation || this.state !== 'playing') return;
      if (this.index + 1 >= this.chunks.length) return this.finish();
      this.index += 1;
      this.emit();
      this.speakCurrent();
    };
    utterance.onerror = (event) => {
      if (generation !== this.generation || ['canceled', 'interrupted'].includes(event.error)) return;
      this.state = 'error';
      this.releaseAwake();
      this.emit();
    };
    if (synth.speaking || synth.pending) {
      synth.cancel();
      // Certains navigateurs ignorent un speak() lancé juste après cancel().
      setTimeout(() => { if (generation === this.generation) synth.speak(utterance); }, 80);
    } else {
      synth.speak(utterance);
    }
  }

  play() {
    this.state = 'playing';
    this.keepAwake();
    this.speakCurrent();
    this.emit();
  }

  pause() {
    this.state = 'paused';
    this.generation += 1;
    synth.cancel();
    this.releaseAwake();
    this.emit();
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  // Avance ou recule d'un paragraphe entier.
  skip(direction) {
    const current = this.chunks[this.index].el;
    let target = this.index;
    if (direction > 0) {
      while (target < this.chunks.length - 1 && this.chunks[target].el === current) target += 1;
    } else {
      while (target > 0 && this.chunks[target].el === current) target -= 1;
      const previous = this.chunks[target].el;
      while (target > 0 && this.chunks[target - 1].el === previous) target -= 1;
    }
    this.jump(target);
  }

  jump(index) {
    this.index = Math.max(0, Math.min(index, this.chunks.length - 1));
    if (this.state === 'playing') this.speakCurrent();
    this.emit();
  }

  // Applique tout de suite un changement de vitesse ou de voix.
  refresh() {
    if (this.state === 'playing') this.speakCurrent();
  }

  finish() {
    this.state = 'ended';
    this.index = 0;
    this.releaseAwake();
    this.emit();
  }

  destroy() {
    this.generation += 1;
    this.state = 'idle';
    synth.cancel();
    this.releaseAwake();
    document.removeEventListener('visibilitychange', this.onVisible);
  }
}
