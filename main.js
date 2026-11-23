// Call Transcription: a plugin for the unofficial Sangoma Phone builds (sangoma-phone-linux).
// Call audio arrives live from the app, is cut into utterances and sent to a Whisper server; the text
// shows up in the transcript window a moment after it was said.
'use strict';
const { Segmenter, wav } = require('./lib/segmenter');
const { Store } = require('./lib/store');

const SPEAKER = { local: 'You', remote: 'Caller' };
let api, store, win = null;
const live = new Map();   // call id -> { conversation, segmenters: { local, remote }, pending }
let queue = Promise.resolve();
let lastError = null;

const limitFor = s => (s.saveLocally ? Infinity : api.system.totalMemory * Math.min(85, s.memoryPercent) / 100);
const storeOptions = s => ({ limitBytes: limitFor(s), folder: s.saveLocally ? s.folder : '' });

async function transcribe(pcm) {
  const s = api.settings.get();
  const url = s.server.replace(/\/+$/, '') + '/' + s.endpoint.replace(/^\/+/, '');
  const headers = {};
  if (s.authHeader && s.authValue) headers[s.authHeader] = s.authValue;
  let body = wav(pcm);
  if (s.api === 'openai') {
    const form = new FormData();
    form.append('file', new Blob([body], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', s.model || 'whisper-1');
    if (s.language) form.append('language', s.language);
    form.append('response_format', 'json');
    body = form;
  } else headers['content-type'] = 'audio/wav';
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${url} answered ${res.status}${res.status === 401 ? ' (check the secret under Plugins)' : ''}`);
  return String((await res.json()).text || '').trim();
}

const view = c => ({ id: c.id, number: c.number, display: c.display, startedAt: c.startedAt, endedAt: c.endedAt, lines: c.lines });
const snapshot = () => ({
  conversations: store.conversations.map(view), evicted: store.evicted, error: lastError,
  saving: !!store.folder, folder: store.folder, liveIds: [...live.values()].map(l => l.conversation.id),
});
const refresh = () => api.send('state', snapshot());

// In builds whose plugin host has it, the transcripts are an entry in the app's top bar (after Chat);
// in older ones they get a window of their own.
function openWindow() {
  if (api.showNavItem) return api.showNavItem('transcripts');
  if (win && !win.isDestroyed()) { win.show(); return; }
  win = api.openWindow('window/transcripts.html', { width: 720, height: 620, title: 'Call Transcripts' });
}

const ANSWERED = new Set(['onThePhone', 'onHold']);

// A call only becomes a conversation once it is answered: calls that ring and are never taken (and the
// ringing before an answer) are not transcribed and leave nothing behind.
function startCall(call) {
  if (live.has(call.id) || !ANSWERED.has(call.state)) return;
  const conversation = store.start({ ...call, startedAt: Date.now() });
  const entry = { conversation, segmenters: {}, pending: 0 };
  for (const channel of ['local', 'remote']) {
    entry.segmenters[channel] = new Segmenter(u => {
      entry.pending++;
      // One request at a time, in the order things were said.
      queue = queue.then(async () => {
        try {
          const text = await transcribe(u.pcm);
          lastError = null;
          if (text) store.addLine(conversation, { at: u.startedAt, speaker: SPEAKER[channel], text });
        } catch (e) {
          lastError = e.message;
          api.log('transcription failed:', e.message);
        }
        entry.pending--;
        refresh();
      });
    });
  }
  live.set(call.id, entry);
  if (api.settings.get().openOnCall) openWindow();
  refresh();
}

function endCall(call) {
  const entry = live.get(call.id);
  if (!entry) return;
  for (const s of Object.values(entry.segmenters)) s.flush();
  live.delete(call.id);
  queue = queue.then(() => {
    if (entry.conversation.lines.length) store.end(entry.conversation, call.endedAt || Date.now());
    else store.remove(entry.conversation.id);  // answered, but nothing was said
    refresh();
  });
  refresh();
}

module.exports = {
  activate(pluginApi) {
    api = pluginApi;
    store = new Store(storeOptions(api.settings.get()));
    api.settings.onChange(s => { try { store.configure(storeOptions(s)); lastError = null; } catch (e) { lastError = `Can't use the folder: ${e.message}`; } refresh(); });
    api.calls.on('start', startCall);
    api.calls.on('update', call => {
      startCall(call);  // answered now?
      const entry = live.get(call.id);
      if (entry) { Object.assign(entry.conversation, { number: call.number || entry.conversation.number, display: call.display || entry.conversation.display }); refresh(); }
    });
    api.calls.on('end', endCall);
    api.audio.on(({ callId, channel, pcm }) => {
      live.get(callId)?.segmenters[channel].push(pcm);
    });
    api.handle('state', snapshot);
    api.handle('remove', id => { store.remove(id); refresh(); });
    api.onAction('open', openWindow);
    if (api.addNavItem) api.addNavItem({ id: 'transcripts', label: 'Transcripts', file: 'window/transcripts.html' });
  },
  deactivate() { for (const id of [...live.keys()]) endCall({ id, endedAt: Date.now() }); },
};
