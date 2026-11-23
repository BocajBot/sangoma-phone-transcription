// Conversations and their lines: in memory with a size limit, or as files in a folder. Pure Node.
'use strict';
const fs = require('fs');
const path = require('path');

const sizeOf = c => 200 + 2 * (String(c.number).length + String(c.display).length) + c.lines.reduce((n, l) => n + 80 + 2 * l.text.length, 0);
const fileName = c => `${new Date(c.startedAt).toISOString().replace(/[:.]/g, '-')}_${String(c.display || c.number || 'call').replace(/[^\w.-]+/g, '_').slice(0, 40)}.json`;

class Store {
  // limitBytes: how much the conversations kept in memory may take. folder: where to save them ('' = don't).
  constructor({ limitBytes = Infinity, folder = '' } = {}) {
    this.conversations = [];  // oldest first
    this.evicted = 0;
    this.configure({ limitBytes, folder });
  }

  configure({ limitBytes, folder }) {
    this.limitBytes = limitBytes;
    const changed = folder !== this.folder;
    this.folder = folder;
    if (folder && changed) {
      fs.mkdirSync(folder, { recursive: true });
      for (const c of this.conversations) this.save(c);  // what was only in memory is kept from now on
      const known = new Set(this.conversations.map(c => c.file));
      for (const f of fs.readdirSync(folder).filter(f => f.endsWith('.json') && !known.has(f)).sort()) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'));
          if (Array.isArray(c.lines) && c.startedAt) this.conversations.push({ ...c, file: f });
        } catch { /* not one of ours */ }
      }
      this.conversations.sort((a, b) => a.startedAt - b.startedAt);
    }
    this.evict();
  }

  start(call) {
    const c = { id: `${call.id}-${call.startedAt}`, callId: call.id, number: call.number || '', display: call.display || '', startedAt: call.startedAt, endedAt: null, lines: [] };
    c.file = fileName(c);
    this.conversations.push(c);
    return c;
  }

  addLine(c, line) {
    c.lines.push(line);
    c.lines.sort((a, b) => a.at - b.at);  // the two speakers are transcribed side by side
    this.save(c);
    this.evict(c);
  }

  end(c, endedAt) { c.endedAt = endedAt; this.save(c); }

  save(c) {
    if (!this.folder) return;
    const { file, ...data } = c;
    fs.writeFileSync(path.join(this.folder, file), JSON.stringify(data, null, 2));
  }

  bytes() { return this.conversations.reduce((n, c) => n + sizeOf(c), 0); }

  // Over the limit: the oldest conversations leave memory (files in the folder stay). The conversation
  // in progress is never dropped.
  evict(keep) {
    while (this.conversations.length > 1 && this.bytes() > this.limitBytes) {
      const i = this.conversations.findIndex(c => c !== keep && c.endedAt !== null);
      if (i < 0) break;
      this.conversations.splice(i, 1);
      this.evicted++;
    }
  }

  remove(id) {
    const i = this.conversations.findIndex(c => c.id === id);
    if (i < 0) return;
    const [c] = this.conversations.splice(i, 1);
    if (this.folder) fs.rmSync(path.join(this.folder, c.file), { force: true });
  }
}

module.exports = { Store, sizeOf };
