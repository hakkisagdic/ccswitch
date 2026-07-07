'use strict';
// Epic F: read OTHER agents' session logs into keyflip's unified conversation shape (the same
// { messages:[{role,text,tools,ts}], cwd, counts } that src/transcript.js produces for Claude
// Code), so the same export/markdown/HTML rendering works across tools.
//
// Format confidence:
//   - message-event JSONL → HIGH: reuses the tested transcript.parse (Claude Code, Gemini).
//   - Cursor SQLite (`cursorDiskKV`) → the FILE reader (src/sqliteread.js) is verified against
//     real sqlite3 fixtures; the bubble→message MAPPING is best-effort (Cursor's schema is
//     NEEDS-VERIFICATION — confirm against a real install).
//   - generic JSON of messages → tolerant: finds the biggest array of {role, text/content} objects.
//   - Aider `.aider.chat.history.md` → best-effort markdown (`#### ` user, `> ` tool, else assistant).
// Copilot (YAML) is deferred (needs a YAML parser).

function countsOf(m) { return { messages: m.length, user: m.filter(function (x) { return x.role === 'user'; }).length, assistant: m.filter(function (x) { return x.role === 'assistant'; }).length }; }
function dedupe(a) { const seen = {}; return (a || []).filter(function (x) { if (!x || seen[x]) return false; seen[x] = 1; return true; }); }
function asBuffer(input) { return Buffer.isBuffer(input) ? input : Buffer.from(String(input == null ? '' : input), 'utf8'); }

// Detect the source format from filename + a header sniff (works on a Buffer or string).
function detect(filePath, input) {
  const buf = asBuffer(input);
  if (buf.length >= 16 && buf.toString('latin1', 0, 15) === 'SQLite format 3') return 'cursor';
  const p = String(filePath || '').toLowerCase();
  const head = buf.toString('utf8', 0, 2000);
  if (/\.aider\.chat\.history\.md$/.test(p) || /^#\s*aider chat started/m.test(head)) return 'aider';
  if (/\.jsonl$/.test(p)) return 'jsonl';
  const firstLine = (head.split('\n').find(function (l) { return l.trim(); }) || '').trim();
  if (firstLine[0] === '{') {
    try { const o = JSON.parse(firstLine); if (o && (o.message || o.type || o.role)) return 'jsonl'; } catch (e) { /* maybe a whole-file JSON */ }
    // a whole-file JSON document (opencode / generic)?
    try { JSON.parse(head.length < 2000 ? buf.toString('utf8') : head); return 'json'; } catch (e) { /* not a small json */ }
    if (/"(messages|parts|conversation)"\s*:/.test(head)) return 'json';
  }
  if (firstLine[0] === '[' ) return 'json';
  if (/\.md$/.test(p)) return 'aider';
  return null;
}

// Aider markdown chat history → unified shape.
function parseAider(text) {
  const messages = [];
  let cur = null;
  const flush = function () { if (cur && cur.text.trim()) messages.push({ role: 'assistant', text: cur.text.trim(), tools: dedupe(cur.tools), ts: null }); cur = null; };
  String(text == null ? '' : text).split('\n').forEach(function (line) {
    if (/^####\s/.test(line)) { flush(); messages.push({ role: 'user', text: line.replace(/^####\s+/, '').trim(), tools: [], ts: null }); cur = { text: '', tools: [] }; return; }
    if (/^#\s*aider chat started/i.test(line)) { flush(); return; }
    if (/^>\s?/.test(line)) {
      if (cur) { const s = line.replace(/^>\s?/, '');
        if (/^Applied edit/i.test(s)) cur.tools.push('edit');
        else if (/^Commit/i.test(s)) cur.tools.push('commit');
        else if (/^(Added|Removed)\b/i.test(s)) cur.tools.push('files');
        else if (/^Running\b/i.test(s)) cur.tools.push('run'); }
      return;
    }
    if (!cur) cur = { text: '', tools: [] };
    cur.text += (cur.text ? '\n' : '') + line;
  });
  flush();
  const msgs = messages.filter(function (m) { return m.text || m.tools.length; });
  return { messages: msgs, cwd: null, counts: countsOf(msgs) };
}

// Cursor SQLite (`cursorDiskKV`): bubbles are `bubbleId:<composer>:<id>` JSON rows; the composer
// row may carry the order. Best-effort mapping over the verified SQLite reader.
function textOf(j) {
  if (!j || typeof j !== 'object') return '';
  if (typeof j.text === 'string' && j.text.trim()) return j.text.trim();
  if (typeof j.content === 'string' && j.content.trim()) return j.content.trim();
  if (Array.isArray(j.content)) { const t = j.content.filter(function (b) { return b && b.type === 'text' && b.text; }).map(function (b) { return b.text; }).join('\n'); if (t.trim()) return t.trim(); }
  return '';
}
function roleOf(j) {
  if (j && (j.role === 'assistant' || j.role === 'user')) return j.role;
  if (j && (j.type === 2 || j.type === 'ai' || j.isAgentic)) return 'assistant';
  return 'user';
}
function parseCursor(buf) {
  const sq = require('./sqliteread');
  const kv = sq.readKV(buf, 'cursorDiskKV'); // throws if the table is absent
  const bubbles = [];
  const composers = {};
  Object.keys(kv).forEach(function (k) {
    let m = k.match(/^bubbleId:([^:]+):(.+)$/);
    if (m) { let j; try { j = JSON.parse(kv[k]); } catch (e) { return; } const text = textOf(j); if (text) bubbles.push({ composer: m[1], id: m[2], key: k, role: roleOf(j), text: text }); return; }
    m = k.match(/^composerData:(.+)$/);
    if (m) { try { composers[m[1]] = JSON.parse(kv[k]); } catch (e) { /* ignore */ } }
  });
  if (!bubbles.length) return { messages: [], cwd: null, counts: countsOf([]) };
  // pick the composer with the most bubbles; order by its header list if present, else by key
  const byComposer = {};
  bubbles.forEach(function (b) { (byComposer[b.composer] = byComposer[b.composer] || []).push(b); });
  const composer = Object.keys(byComposer).sort(function (a, b) { return byComposer[b].length - byComposer[a].length; })[0];
  let chosen = byComposer[composer];
  const meta = composers[composer];
  const order = meta && (meta.fullConversationHeadersOnly || meta.conversation || meta.messageIds);
  if (Array.isArray(order) && order.length) {
    const idOf = function (h) { return typeof h === 'string' ? h : (h && (h.bubbleId || h.id)) || ''; };
    const rank = {}; order.forEach(function (h, i) { rank[idOf(h)] = i; });
    chosen = chosen.slice().sort(function (a, b) { const ra = rank[a.id], rb = rank[b.id]; if (ra == null && rb == null) return a.key < b.key ? -1 : 1; if (ra == null) return 1; if (rb == null) return -1; return ra - rb; });
  } else {
    chosen = chosen.slice().sort(function (a, b) { return a.key < b.key ? -1 : 1; });
  }
  const messages = chosen.map(function (b) { return { role: b.role, text: b.text, tools: [], ts: null }; });
  return { messages: messages, cwd: null, counts: countsOf(messages) };
}

// Generic JSON of messages (opencode + others): find the largest array of message-like objects.
function parseJson(text) {
  let doc; try { doc = JSON.parse(text); } catch (e) { throw new Error('not valid JSON'); }
  let best = null;
  (function scan(node) {
    if (Array.isArray(node)) {
      const msgish = node.filter(function (x) { return x && typeof x === 'object' && (x.role || x.type) && (typeof x.text === 'string' || typeof x.content !== 'undefined' || typeof x.message === 'string'); });
      if (msgish.length && (!best || msgish.length > best.length)) best = node;
      node.forEach(scan);
    } else if (node && typeof node === 'object') { Object.keys(node).forEach(function (k) { scan(node[k]); }); }
  })(doc);
  const arr = best || [];
  const messages = arr.map(function (x) {
    const text = typeof x.message === 'string' ? x.message : textOf(x);
    return { role: roleOf(x), text: text, tools: [], ts: (x && (x.timestamp || x.time)) || null };
  }).filter(function (m) { return m.text; });
  return { messages: messages, cwd: (doc && doc.cwd) || null, counts: countsOf(messages) };
}

// Normalize a foreign session (Buffer or string) into the unified shape. Returns { tool, ... }.
function normalize(filePath, input) {
  const buf = asBuffer(input);
  const tool = detect(filePath, buf);
  if (tool === 'cursor') return Object.assign({ tool: 'cursor' }, parseCursor(buf));
  if (tool === 'jsonl') return Object.assign({ tool: 'jsonl' }, require('./transcript').parse(buf.toString('utf8')));
  if (tool === 'json') return Object.assign({ tool: 'json' }, parseJson(buf.toString('utf8')));
  if (tool === 'aider') return Object.assign({ tool: 'aider' }, parseAider(buf.toString('utf8')));
  throw new Error('unrecognized session format (supported: message-event JSONL, JSON, Cursor SQLite, Aider .md)');
}

module.exports = { detect: detect, parseAider: parseAider, parseCursor: parseCursor, parseJson: parseJson, normalize: normalize };
