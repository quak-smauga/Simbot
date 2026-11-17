// NET — WebSocket do serwera qwe (jedna sesja = jedno połączenie). Eventy serwera → onEvent(t, payload);
// ramki binarne (voice.chunk) → onVoice. Reconnect z backoffem.
export function connect({ sessionId, onEvent, onVoice, onStatus }) {
    let ws = null, closed = false, retry = 800;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?session=${encodeURIComponent(sessionId)}`;
    function open() {
        ws = new WebSocket(url); ws.binaryType = 'arraybuffer';
        onStatus('łączę…', 'wait');
        ws.onopen = () => { retry = 800; onStatus('online', 'ok'); };
        ws.onmessage = ev => {
            if (ev.data instanceof ArrayBuffer) { onVoice(unpackVoice(ev.data)); return; }
            let msg; try { msg = JSON.parse(ev.data); } catch { return; }
            onEvent(msg.t, msg);
        };
        ws.onclose = () => { onStatus('offline', 'bad'); if (!closed) setTimeout(open, retry = Math.min(8000, retry * 1.6)); };
        ws.onerror = () => { try { ws.close(); } catch (e) { } };
    }
    open();
    const sendJson = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
    return {
        text: text => sendJson({ t: 'text', text }),
        voice: on => sendJson({ t: 'voice', on }),
        played: sayId => sendJson({ t: 'played', sayId }),
        interrupt: () => sendJson({ t: 'interrupt' }),
        reset: () => sendJson({ t: 'reset' }),
        control: (op, taskId) => sendJson({ t: 'control', op, taskId }),
        send: sendJson,
        audio: buf => { if (ws && ws.readyState === 1) ws.send(buf); },
        close: () => { closed = true; ws && ws.close(); },
        isOpen: () => !!ws && ws.readyState === 1,
    };
}

/** [u8 1][u32 seq][u32 sampleRate][u8 idLen][id][pcm s16le] */
function unpackVoice(ab) {
    const dv = new DataView(ab);
    const seq = dv.getUint32(1, true), sampleRate = dv.getUint32(5, true), idLen = dv.getUint8(9);
    const sayId = new TextDecoder().decode(new Uint8Array(ab, 10, idLen));
    const pcm = new Int16Array(ab.slice(10 + idLen));
    return { sayId, seq, sampleRate, pcm };
}
