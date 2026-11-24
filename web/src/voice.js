// Conversation vocale dans le navigateur, avec prise de parole naturelle :
// le micro reste ouvert pendant que l'IA parle ; dès que l'utilisateur parle, la voix de l'IA
// se suspend puis s'arrête, et ce que l'utilisateur dit devient son message.
//
// Pour ne pas confondre l'utilisateur avec la voix de l'IA captée par le micro (sans casque),
// chaque transcription entendue pendant que l'IA parle est comparée à ce qu'elle est en train
// de dire : si les mots correspondent, c'est un écho et on l'ignore.

const FOCUS_RE = /<focus\s+ids="([^"]*)"\s*\/?>/gi;
const SILENCE_MS = 1300;     // pause qui termine une prise de parole
const DUCK_MS = 180;         // durée de voix détectée avant de suspendre la synthèse
const DUCK_RELEASE_MS = 1100;// sans confirmation de la reconnaissance, on reprend la lecture

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

const words = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(w => w.length > 1);

/**
 * Vrai si `heard` ressemble à ce que l'IA vient de dire (écho du haut-parleur).
 * Exporté pour les tests.
 */
export function isEcho(heard, spoken) {
  const h = words(heard);
  if (!h.length) return true;
  const ref = new Set(words(spoken));
  if (!ref.size) return false;
  const hits = h.filter(w => ref.has(w)).length;
  return hits / h.length >= 0.6;
}

export function voiceSupport() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!window.isSecureContext) return { ok: false, reason: 'La conversation vocale nécessite HTTPS (le navigateur refuse le micro sur une page en HTTP).' };
  if (!SR) return { ok: false, reason: 'Ce navigateur ne propose pas la reconnaissance vocale (utilisez Chrome, Edge ou Safari).' };
  if (!window.speechSynthesis) return { ok: false, reason: 'Ce navigateur ne sait pas lire de texte à voix haute.' };
  return { ok: true, SR };
}

export function createVoice({ onUtterance, onState, onFocus, onTranscript, onBargeIn }) {
  const support = voiceSupport();
  if (!support.ok) return { supported: false, reason: support.reason };

  let active = false;
  let phase = 'off';        // listening | thinking | speaking | off
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
  let recentSpoken = [];    // dernières phrases lues (pour reconnaître l'écho)
  let generation = 0;       // invalide les callbacks d'une réponse interrompue
  let lastSpokeAt = 0;      // fin de la dernière phrase lue (l'écho arrive avec un peu de retard)
  const ECHO_GRACE_MS = 2500;
  /** Vide la file de synthèse (resume d'abord : Chrome resterait en pause après un cancel). */
  const hush = () => { try { speechSynthesis.resume(); } catch { /* */ } speechSynthesis.cancel(); };

  const setState = s => { phase = s; onState?.(s); };
  const aiTalking = () => pending > 0 || !streamDone;

  function utter(text, focusIds) {
    const t = speakable(text);
    if (!t) { if (focusIds?.length) onFocus?.(focusIds); return; }
    const gen = generation;
    const u = new SpeechSynthesisUtterance(t);
    u.lang = 'fr-FR';
    if (voice) u.voice = voice;
    u.rate = 1.05;
    pending++;
    recentSpoken.push(t);
    if (recentSpoken.length > 4) recentSpoken.shift();
    u.onstart = () => { if (gen !== generation) return; setState('speaking'); if (focusIds?.length) onFocus?.(focusIds); };
    const done = () => { lastSpokeAt = Date.now(); if (gen !== generation) return; pending = Math.max(0, pending - 1); maybeIdle(); };
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  }

  function maybeIdle() {
    if (pending || !streamDone || !active) return;
    const cb = afterSpeech; afterSpeech = null;
    if (phase !== 'user') setState('listening');
    if (cb) cb();
  }

  /** Découpe le texte reçu en phrases complètes et les met dans la file de lecture. */
  function consume(full, final) {
    const text = full.replace(/<changes>[\s\S]*$/i, '');
    let rest = text.slice(consumed);
    for (;;) {
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

  /** L'utilisateur prend la parole : l'IA se tait (lecture et réponse en cours). */
  function yieldFloor() {
    generation++;
    ducked = false;
    clearTimeout(duckTimer);
    hush();
    lastSpokeAt = Date.now();
    pending = 0; streamDone = true; afterSpeech = null; consumed = 0;
    setState('user');
    onBargeIn?.();
  }

  // ---------- reconnaissance continue ----------
  let rec = null;
  let startIdx = 0;          // résultats déjà traités (écho ignoré ou message envoyé)
  let heard = '';
  let silenceTimer = null;

  function startRecognition() {
    if (!active) return;
    try {
      rec = new support.SR();
      rec.lang = 'fr-FR';
      rec.continuous = true;
      rec.interimResults = true;
      startIdx = 0;
      rec.onresult = onResult;
      rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setState('denied'); stop(); } };
      rec.onend = () => { rec = null; if (active) setTimeout(startRecognition, 150); }; // Chrome coupe régulièrement
      rec.start();
    } catch { setTimeout(startRecognition, 500); }
  }

  function onResult(e) {
    if (!active) return;
    let text = '';
    let lastFinal = false;
    for (let i = startIdx; i < e.results.length; i++) { text += e.results[i][0].transcript; lastFinal = e.results[i].isFinal !== false; }
    text = text.trim();
    if (!text) return;

    const recentlySpoke = Date.now() - lastSpokeAt < ECHO_GRACE_MS;
    if (phase !== 'user' && !aiTalking() && phase !== 'thinking' && recentlySpoke && isEcho(text, recentSpoken.join(' '))) {
      if (lastFinal) startIdx = e.results.length; // fin d'écho arrivée après la lecture
      return;
    }
    if (phase !== 'user' && (aiTalking() || phase === 'speaking' || phase === 'ducked')) {
      if (isEcho(text, recentSpoken.join(' '))) {
        if (lastFinal) startIdx = e.results.length; // écho confirmé : on l'oublie
        return;
      }
      yieldFloor(); // c'est l'utilisateur : l'IA s'efface
    } else if (phase === 'thinking') {
      yieldFloor(); // il reprend la parole avant la réponse : on annule la demande
    }
    if (phase !== 'user') setState('user');
    heard = text;
    onTranscript?.(text);
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => finishUtterance(e.results.length), SILENCE_MS);
  }

  function finishUtterance(upTo) {
    const text = heard.trim();
    heard = '';
    startIdx = Math.max(startIdx, upTo);
    if (!text) { setState('listening'); return; }
    setState('thinking');
    onUtterance(text);
  }

  // ---------- détection d'activité vocale : la voix de l'IA se suspend dès qu'on parle ----------
  let audioCtx = null, stream = null, vadTimer = null, ducked = false, duckTimer = null;
  let noise = 0.01, echoLevel = 0, loudSince = 0, falseAlarms = 0, vadEnabled = true;

  async function startVad() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(stream);
      const an = audioCtx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      vadTimer = setInterval(() => {
        an.getFloatTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        if (phase !== 'speaking' && phase !== 'ducked') { noise = noise * 0.95 + rms * 0.05; echoLevel = 0; loudSince = 0; return; }
        // Pendant la lecture : niveau d'écho de référence, puis voix nettement au-dessus.
        echoLevel = Math.max(echoLevel * 0.98, rms);
        const threshold = Math.max(noise * 4, 0.03, echoLevel * 0.85 + 0.02);
        if (rms > threshold && vadEnabled) {
          loudSince ||= performance.now();
          if (!ducked && performance.now() - loudSince > DUCK_MS) duck();
        } else loudSince = 0;
      }, 40);
    } catch { /* pas de micro direct : la reconnaissance suffit */ }
  }

  function duck() {
    ducked = true;
    try { speechSynthesis.pause(); } catch { /* non pris en charge */ }
    setState('ducked');
    clearTimeout(duckTimer);
    duckTimer = setTimeout(() => {
      // La reconnaissance n'a rien confirmé : fausse alerte (bruit, écho), on reprend.
      if (!ducked) return;
      ducked = false;
      falseAlarms++;
      if (falseAlarms >= 3) vadEnabled = false; // haut-parleurs trop forts : on s'en remet à la reconnaissance
      try { speechSynthesis.resume(); } catch { /* non pris en charge */ }
      setState('speaking');
    }, DUCK_RELEASE_MS);
  }

  function stopVad() {
    clearInterval(vadTimer); vadTimer = null;
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    audioCtx?.close().catch(() => {}); audioCtx = null;
  }

  function stop() {
    active = false;
    generation++;
    clearTimeout(silenceTimer); clearTimeout(duckTimer);
    try { rec?.abort(); } catch { /* déjà arrêté */ }
    rec = null;
    hush();
    stopVad();
    pending = 0; streamDone = true; afterSpeech = null;
    setState('off');
  }

  return {
    supported: true,
    get active() { return active; },
    start() {
      active = true; falseAlarms = 0; vadEnabled = true;
      hush();
      setState('listening');
      startRecognition();
      startVad();
    },
    stop,
    /** Interruption manuelle (clic sur l'indicateur). */
    interrupt() { yieldFloor(); setState('listening'); },
    // flux de la réponse
    beginResponse() { generation++; hush(); pending = 0; consumed = 0; streamDone = false; setState('thinking'); },
    pushResponse(full) { consume(full, false); },
    endResponse(full, then) { consume(full, true); streamDone = true; afterSpeech = then || null; maybeIdle(); },
    /** Lit un texte, puis exécute `then`. */
    say(text, { focus, then } = {}) { generation++; hush(); pending = 0; streamDone = true; afterSpeech = then || null; utter(text, focus); if (!pending) maybeIdle(); }
  };
}
