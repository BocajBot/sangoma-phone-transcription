// Cuts a stream of 16 kHz mono PCM into utterances: speech bounded by silence. Pure, no dependencies.
'use strict';

class Segmenter {
  // onUtterance({ pcm: Int16Array, startedAt, endedAt })
  constructor(onUtterance, { sampleRate = 16000, silenceMs = 700, maxMs = 12000, minMs = 300, threshold = 500, padMs = 200, now = Date.now } = {}) {
    Object.assign(this, { onUtterance, sampleRate, threshold, now });
    this.silence = sampleRate * silenceMs / 1000;
    this.max = sampleRate * maxMs / 1000;
    this.min = sampleRate * minMs / 1000;
    this.pad = sampleRate * padMs / 1000;
    this.chunks = [];      // audio of the utterance in progress
    this.length = 0;
    this.speech = 0;       // samples in it that were loud enough to be speech
    this.quiet = 0;        // samples of silence at its end
    this.lead = [];        // the last bit of silence, kept to put before the next utterance
    this.leadLength = 0;
    this.startedAt = 0;
  }

  push(pcm) {
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
    const loud = Math.sqrt(sum / (pcm.length || 1)) >= this.threshold;
    if (!this.length && !loud) {  // between utterances: remember a little, so words keep their first sound
      this.lead.push(pcm);
      this.leadLength += pcm.length;
      while (this.lead.length > 1 && this.leadLength - this.lead[0].length >= this.pad) this.leadLength -= this.lead.shift().length;
      return;
    }
    if (!this.length) {
      this.startedAt = this.now();
      this.chunks = this.lead; this.length = this.leadLength;
      this.lead = []; this.leadLength = 0;
    }
    this.chunks.push(pcm);
    this.length += pcm.length;
    if (loud) { this.speech += pcm.length; this.quiet = 0; } else this.quiet += pcm.length;
    if (this.quiet >= this.silence || this.length >= this.max) this.flush();
  }

  // End the utterance in progress (also called when the call ends).
  flush() {
    const { chunks, length, speech, startedAt } = this;
    this.chunks = []; this.length = 0; this.speech = 0; this.quiet = 0;
    if (speech < this.min) return;
    const pcm = new Int16Array(length);
    let at = 0;
    for (const c of chunks) { pcm.set(c, at); at += c.length; }
    this.onUtterance({ pcm, startedAt, endedAt: this.now() });
  }
}

// 16-bit mono WAV file for a piece of PCM.
function wav(pcm, sampleRate = 16000) {
  const b = Buffer.alloc(44 + pcm.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + pcm.length * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(pcm.length * 2, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2).copy(b, 44);
  return b;
}

module.exports = { Segmenter, wav };
