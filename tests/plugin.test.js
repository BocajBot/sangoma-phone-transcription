// node --test tests/*.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Segmenter, wav } = require('../lib/segmenter');
const { Store, sizeOf } = require('../lib/store');

const chunk = (ms, level) => new Int16Array(16 * ms).fill(level);

test('segmenter: speech bounded by silence becomes one utterance, with a little lead-in', () => {
  const out = [];
  let clock = 1000;
  const s = new Segmenter(u => out.push(u), { now: () => clock });
  for (let i = 0; i < 10; i++) s.push(chunk(100, 0));          // silence before
  clock = 2000;
  for (let i = 0; i < 10; i++) s.push(chunk(100, 3000));       // 1 s of speech
  for (let i = 0; i < 6; i++) s.push(chunk(100, 0));
  assert.equal(out.length, 0, 'not cut during a short pause');
  s.push(chunk(100, 0));                                       // 700 ms of silence ends it
  assert.equal(out.length, 1);
  assert.equal(out[0].startedAt, 2000);
  assert.equal(out[0].pcm.length, 16 * (200 + 1000 + 700), '200 ms lead-in + speech + the closing silence');
  for (let i = 0; i < 20; i++) s.push(chunk(100, 0));
  assert.equal(out.length, 1, 'silence alone is never sent');
});

test('segmenter: a click is ignored, long speech is cut, the rest is flushed when the call ends', () => {
  const out = [];
  const s = new Segmenter(u => out.push(u));
  s.push(chunk(100, 3000));
  for (let i = 0; i < 8; i++) s.push(chunk(100, 0));
  assert.equal(out.length, 0, 'under 300 ms of sound is not speech');
  for (let i = 0; i < 130; i++) s.push(chunk(100, 3000));      // 13 s without a pause
  assert.equal(out.length, 1, 'cut at 12 s');
  s.flush();
  assert.equal(out.length, 2, 'what is left goes out when the call ends');
});

test('wav: a valid 16 kHz mono 16-bit header', () => {
  const b = wav(new Int16Array([1, -2, 3]));
  assert.equal(b.length, 50);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.readUInt32LE(24), 16000);
  assert.equal(b.readUInt16LE(22), 1);
  assert.equal(b.readInt16LE(46), -2);
});

test('store: in memory, the oldest finished conversations make room; the live one stays', () => {
  const s = new Store({ limitBytes: 3000 });
  const mk = (id, t) => s.start({ id, number: '100', display: 'A', startedAt: t });
  const a = mk('a', 1), b = mk('b', 2);
  for (let i = 0; i < 5; i++) s.addLine(a, { at: i, speaker: 'You', text: 'x'.repeat(100) });
  s.end(a, 10);
  for (let i = 0; i < 5; i++) s.addLine(b, { at: 20 + i, speaker: 'Caller', text: 'y'.repeat(100) });
  s.end(b, 30);
  const c = mk('c', 40);
  for (let i = 0; i < 20; i++) s.addLine(c, { at: 50 + i, speaker: 'You', text: 'z'.repeat(100) });
  assert.deepEqual(s.conversations.map(x => x.callId), ['c'], 'a and b were dropped, oldest first');
  assert.equal(s.evicted, 2);
  assert.ok(sizeOf(c) > 3000, 'the conversation in progress is kept even over the limit');
});

test('store: saving to a folder writes each conversation, reloads them, and delete removes the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcripts-'));
  try {
    const s = new Store({ limitBytes: Infinity });
    const a = s.start({ id: 'a', number: '5551234', display: 'Ann / Sales', startedAt: Date.UTC(2026, 0, 2, 3, 4, 5) });
    s.addLine(a, { at: 2, speaker: 'Caller', text: 'second' });
    s.addLine(a, { at: 1, speaker: 'You', text: 'first' });
    assert.deepEqual(a.lines.map(l => l.text), ['first', 'second'], 'lines are kept in the order they were said');
    s.configure({ limitBytes: Infinity, folder: dir });    // switching "save locally" on keeps what was in memory
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^2026-01-02T03-04-05-000Z_Ann_Sales\.json$/);
    const again = new Store({ limitBytes: Infinity, folder: dir });
    assert.equal(again.conversations.length, 1);
    assert.equal(again.conversations[0].lines[1].text, 'second');
    again.remove(again.conversations[0].id);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
