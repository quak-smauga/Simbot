// AUDIO — odtwarzacz PCM (głos asystenta) z analizatorem RMS → kropka, oraz mikrofon → PCM 16k → serwer.
// Odtwarzacz: każdy chunk to AudioBuffer wstawiony w kolejkę czasu (gapless). Gdy serwer powie voice.end
// i ostatni bufor dogra — onPlayed(sayId) → serwer odmuta mikrofon.

export function makePlayer({ onPlayed }) {
    let ctx = null, analyser = null, timeData = null, gain = null;
    let nextTime = 0;
    const lines = new Map();   // sayId → { pending: n, ended: bool }
    let active = 0;

    function ensure() {
        if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        gain = ctx.createGain(); analyser = ctx.createAnalyser();
        analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.45;
        timeData = new Uint8Array(analyser.fftSize);
        gain.connect(analyser); analyser.connect(ctx.destination);
    }
    function line(sayId) { let l = lines.get(sayId); if (!l) { l = { pending: 0, ended: false }; lines.set(sayId, l); } return l; }
    function chunk({ sayId, sampleRate, pcm }) {
        ensure();
        if (!pcm.length) return;
        const buf = ctx.createBuffer(1, pcm.length, sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(gain);
        const now = ctx.currentTime;
        if (nextTime < now + 0.04) nextTime = now + 0.04;      // mały bufor przed pierwszym dźwiękiem
        src.start(nextTime); nextTime += buf.duration;
        const l = line(sayId); l.pending++; active++;
        src.onended = () => { l.pending--; active--; check(sayId); };
    }
    function end(sayId) { const l = line(sayId); l.ended = true; check(sayId); }
    function check(sayId) {
        const l = lines.get(sayId);
        if (l && l.ended && l.pending <= 0) { lines.delete(sayId); onPlayed && onPlayed(sayId); }
    }
    function abort() {
        // najprościej: zamknij i otwórz kontekst — wszystkie zaplanowane bufory znikają
        lines.clear(); active = 0; nextTime = 0;
        if (ctx) { const old = ctx; ctx = null; try { old.close(); } catch (e) { } }
    }
    /** RMS 0..1 w skali jak AUDIO.level() z SimWorld (-1 = nic nie gra). */
    function level() {
        if (!ctx || active <= 0 || !analyser) return -1;
        analyser.getByteTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) { const v = (timeData[i] - 128) / 128; sum += v * v; }
        return Math.max(0, Math.min(1, (Math.sqrt(sum / timeData.length) - 0.012) * 6.5));
    }
    return { ensure, chunk, end, abort, level, isPlaying: () => active > 0, context: () => ctx };
}

/** Mikrofon → PCM s16le mono 16 kHz. onFrame(ArrayBuffer), onLevel(rms 0..1). */
export async function openMic({ onFrame, onLevel, targetRate = 16000 }) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        video: false,
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    const ratio = ctx.sampleRate / targetRate;
    let muted = false, acc = 0;
    proc.onaudioprocess = e => {
        const inp = e.inputBuffer.getChannelData(0);
        let sum = 0; for (let i = 0; i < inp.length; i++) sum += inp[i] * inp[i];
        onLevel && onLevel(Math.sqrt(sum / inp.length));
        if (muted) return;
        // decymacja z uśrednianiem (48k → 16k = co 3 próbki)
        const outLen = Math.floor((inp.length - acc) / ratio);
        const out = new Int16Array(outLen);
        let pos = acc;
        for (let i = 0; i < outLen; i++) {
            const a = Math.floor(pos), b = Math.min(inp.length, Math.floor(pos + ratio));
            let s = 0, n = 0; for (let j = a; j < b; j++) { s += inp[j]; n++; }
            const v = n ? s / n : 0;
            out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
            pos += ratio;
        }
        acc = pos - inp.length;
        onFrame(out.buffer);
    };
    src.connect(proc); proc.connect(ctx.destination);   // ScriptProcessor musi być podpięty, żeby tykał
    return {
        setMuted: m => { muted = !!m; }, isMuted: () => muted,
        close: () => { try { proc.disconnect(); src.disconnect(); stream.getTracks().forEach(t => t.stop()); ctx.close(); } catch (e) { } },
    };
}
