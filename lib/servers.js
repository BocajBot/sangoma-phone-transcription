// Sends an utterance to the speech-to-text server, and to a second one when the first can't be reached.
// Pure apart from fetch, which can be replaced in tests.
'use strict';
const { wav } = require('./segmenter');

const RETRY_MS = 30000;      // how long the main server is left alone after it failed
const MAIN_TIMEOUT = 15000;  // with a fallback at hand, don't wait long for the main one
const TIMEOUT = 60000;

const main = s => ({ name: 'main', server: s.server, endpoint: s.endpoint, api: s.api, model: s.model, language: s.language, authHeader: s.authHeader, authValue: s.authValue });
const second = s => ({ name: 'fallback', server: s.fallbackServer, endpoint: s.fallbackEndpoint, api: s.fallbackApi, model: s.fallbackModel, language: s.language, authHeader: s.fallbackAuthHeader, authValue: s.fallbackAuthValue });

async function post(target, pcm, timeout, fetchImpl) {
  const url = String(target.server || '').replace(/\/+$/, '') + '/' + String(target.endpoint || '').replace(/^\/+/, '');
  const headers = {};
  if (target.authHeader && target.authValue) headers[target.authHeader] = target.authValue;
  let body = wav(pcm);
  if (target.api === 'openai') {
    const form = new FormData();
    form.append('file', new Blob([body], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', target.model || 'whisper-1');
    if (target.language) form.append('language', target.language);
    form.append('response_format', 'json');
    body = form;
  } else headers['content-type'] = 'audio/wav';
  let res;
  try { res = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new Error(`${url} can't be reached (${e.cause?.code || e.name || e.message})`); }
  if (!res.ok) throw new Error(`${url} answered ${res.status}${res.status === 401 ? ' (check the secret under Plugins)' : ''}`);
  return String((await res.json()).text || '').trim();
}

// getSettings() returns the plugin's current settings each time, so changes apply to the next utterance.
function createClient(getSettings, { fetchImpl = fetch, now = Date.now } = {}) {
  let mainDownUntil = 0, using = 'main', mainError = null;
  return {
    async transcribe(pcm) {
      const s = getSettings();
      const hasSecond = !!(s.fallbackEnabled && s.fallbackServer);
      if (!hasSecond || now() >= mainDownUntil) {
        try {
          const text = await post(main(s), pcm, hasSecond ? MAIN_TIMEOUT : TIMEOUT, fetchImpl);
          using = 'main'; mainError = null; mainDownUntil = 0;
          return text;
        } catch (e) {
          if (!hasSecond) throw e;
          mainError = e.message;
          mainDownUntil = now() + RETRY_MS;  // don't hold up every utterance on a server that is away
        }
      }
      const text = await post(second(s), pcm, TIMEOUT, fetchImpl);
      using = 'fallback';
      return text;
    },
    status: () => ({ using, mainError }),
  };
}

module.exports = { createClient, RETRY_MS };
