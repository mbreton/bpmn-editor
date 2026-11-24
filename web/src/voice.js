// Conversation vocale dans le navigateur : reconnaissance continue (Web Speech API), envoi
// automatique après une pause, lecture des réponses phrase par phrase au fil du flux, avec
// déclenchement des balises <focus> au moment où la phrase est prononcée.

const FOCUS_RE = /<focus\s+ids="([^"]*)"\s*\/?>/gi;
const SILENCE_MS = 1300;

/** Texte prononçable : sans balises, sans markdown, sans identifiants techniques. */
export function speakable(text) {
  return String(text)
    .replace(/<changes>[\s\S]*?(<\/changes>|$)/gi, '')
    .replace(FOCUS_RE, '')
    .replace(/<[^>]+>/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\*\*|__|[*_#>]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\[[A-Za-z_][\w.-]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function voiceSupport() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!window.isSecureContext) return { ok: false, reason: 'La conversation vocale nécessite HTTPS (le navigateur refuse le micro sur une page en HTTP).' };
  if (!SR) return { ok: false, reason: 'Ce navigateur ne propose pas la reconnaissance vocale (utilisez Chrome, Edge ou Safari).' };
  if (!window.speechSynthesis) return { ok: false, reason: 'Ce navigateur ne sait pas lire de texte à voix haute.' };
  return { ok: true, SR };
}

export function createVoice({ onUtterance, onState, onFocus, onTranscript }) {
  const support = voiceSupport();
  if (!support.ok) return { supported: false, reason: support.reason };

  let active = false;
  let rec = null;
  let listening = false;
  let silenceTimer = null;
  let heard = '';
  let voice = null;

  // ---------- synthèse ----------
  function pickVoice() {
    const voices = speechSynthesis.getVoices().filter(v => /^fr(-|_|$)/i.test(v.lang));
    const pref = [/Google.*fran/i, /Amélie|Amelie/i, /Thomas/i, /Audrey|Aurélie|Marie|Denise|Henri|Natural/i];
    voice = pref.map(re => voices.find(v => re.test(v.name))).find(Boolean) || voices.find(v => /fr-FR/i.test(v.lang)) || voices[0] || null;
  }
  pickVoice();
  speechSynthesis.addEventListener?.('voiceschanged', pickVoice);

  let pending = 0;
  let streamDone = true;
  let consumed = 0;
  let afterSpeech = null;

  function utter(text, focusIds) {
    const t = speakable(text);
    if (!t && !focusIds?.length) return;
    if (!t) { onFocus?.(focusIds); return; }
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'fr-FR';
    if (voice) u.voice = voice;
    u.rate = 1.05;
    pending++;
    u.onstart = () => { setState('speaking'); if (focusIds?.length) onFocus?.(focusIds); };
    const done = () => { pending = Math.max(0, pending - 1); maybeIdle(); };
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  }

  function maybeIdle() {
    if (pending || !streamDone || !active) return;
    const cb = afterSpeech; afterSpeech = null;
    if (cb) cb(); else listen();
  }

  /** Découpe le texte reçu en phrases complètes et les met dans la file de lecture. */
  function consume(full, final) {
    const text = full.replace(/<changes>[\s\S]*$/i, '');
    let rest = text.slice(consumed);
    for (;;) {
      // Ne pas couper au milieu d'une balise <focus …> en cours de réception.
      const openTag = rest.lastIndexOf('<');
      const safe = openTag >= 0 && rest.indexOf('>', openTag) < 0 && !final ? rest.slice(0, openTag) : rest;
      const m = /([.!?…;:])(\s)|\n+/.exec(safe);
      if (!m) break;
      const end = m.index + m[0].length;
      emit(rest.slice(0, end));
      consumed += end;
      rest = rest.slice(end);
    }
    if (final) { if (rest.trim()) emit(rest); consumed = text.length; }
  }

  function emit(segment) {
    const ids = [];
    segment.replace(FOCUS_RE, (_, list) => { ids.push(...list.split(',').map(s => s.trim()).filter(Boolean)); return ''; });
    utter(segment, ids);
  }

  // ---------- reconnaissance ----------
  function setState(s) { onState?.(s); }

  function listen() {
    if (!active || listening) return;
    heard = '';
    onTranscript?.('');
    try {
      rec = new support.SR();
      rec.lang = 'fr-FR';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = e => {
        let t = '';
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        heard = t;
        onTranscript?.(t);
        clearTimeout(silenceTimer);
        silenceTimer = setTimeout(finishUtterance, SILENCE_MS);
      };
      rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setState('denied'); stop(); } };
      rec.onend = () => { listening = false; if (active && !heard.trim() && pending === 0 && streamDone) setTimeout(listen, 200); };
      rec.start();
      listening = true;
      setState('listening');
    } catch { listening = false; }
  }

  function stopListening() {
    clearTimeout(silenceTimer);
    listening = false;
    try { rec?.abort(); } catch { /* déjà arrêté */ }
    rec = null;
  }

  function finishUtterance() {
    const text = heard.trim();
    stopListening();
    if (!text) { listen(); return; }
    setState('thinking');
    onUtterance(text);
  }

  function stop() {
    active = false;
    stopListening();
    speechSynthesis.cancel();
    pending = 0; streamDone = true; afterSpeech = null;
    setState('off');
  }

  return {
    supported: true,
    get active() { return active; },
    start() { active = true; speechSynthesis.cancel(); listen(); },
    stop,
    /** Coupe la parole de l'IA et rend la main à l'utilisateur. */
    interrupt() { speechSynthesis.cancel(); pending = 0; streamDone = true; afterSpeech = null; stopListening(); listen(); },
    // flux de la réponse
    beginResponse() { stopListening(); speechSynthesis.cancel(); pending = 0; consumed = 0; streamDone = false; setState('thinking'); },
    pushResponse(full) { consume(full, false); },
    endResponse(full, then) { consume(full, true); streamDone = true; afterSpeech = then || null; maybeIdle(); },
    /** Lit un texte, puis exécute `then` (ou réécoute). */
    say(text, { focus, then } = {}) { stopListening(); speechSynthesis.cancel(); pending = 0; streamDone = true; afterSpeech = then || null; utter(text, focus); if (!pending) maybeIdle(); },
    listen
  };
}
