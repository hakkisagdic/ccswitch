'use strict';
// Epic F (v1): read OTHER agents' session logs into keyflip's unified conversation shape
// (the same { messages:[{role,text,tools,ts}], cwd, counts } that src/transcript.js produces
// for Claude Code), so the same export/markdown/HTML rendering works across tools.
//
// Format confidence:
//   - JSONL of message events  → HIGH: reuses the tested transcript.parse (Claude Code, and
//     any message-event JSONL like Gemini's transcript.jsonl).
//   - Aider `.aider.chat.history.md` → BEST-EFFORT: the documented markdown shape (`#### ` =
//     user turn, `> ` = aider status/tool lines, other text = assistant). VERIFY against a real
//     Aider install before relying on it; the parser is isolated so a fix is one function.
// Cursor (SQLite) and Copilot (YAML) need a runtime dep to parse and are intentionally deferred.

// Detect the source format from the filename + a content sniff.
function detect(filePath, text) {
  const p = String(filePath || '').toLowerCase();
  const head = String(text || '').slice(0, 2000);
  if (/\.aider\.chat\.history\.md$/.test(p) || /^#\s*aider chat started/m.test(head)) return 'aider';
  if (/\.jsonl$/.test(p)) return 'jsonl';
  // sniff: a first non-blank line that parses as a JSON object with a `message`/`type` → jsonl
  const firstLine = (head.split('\n').find(function (l) { return l.trim(); }) || '').trim();
  if (firstLine[0] === '{') { try { const o = JSON.parse(firstLine); if (o && (o.message || o.type || o.role)) return 'jsonl'; } catch (e) { /* not jsonl */ } }
  if (/\.md$/.test(p)) return 'aider'; // last resort for a markdown chat log
  return null;
}

// Aider markdown chat history → unified shape.
function parseAider(text) {
  const messages = [];
  let cur = null; // the assistant turn currently accumulating
  const flush = function () { if (cur && cur.text.trim()) messages.push({ role: 'assistant', text: cur.text.trim(), tools: dedupe(cur.tools), ts: null }); cur = null; };
  String(text == null ? '' : text).split('\n').forEach(function (line) {
    if (/^####\s/.test(line)) { flush(); messages.push({ role: 'user', text: line.replace(/^####\s+/, '').trim(), tools: [], ts: null }); cur = { text: '', tools: [] }; return; }
    if (/^#\s*aider chat started/i.test(line)) { flush(); return; } // session banner
    if (/^>\s?/.test(line)) { // aider status / tool output — summarize, don't dump
      if (cur) {
        const s = line.replace(/^>\s?/, '');
        if (/^Applied edit/i.test(s)) cur.tools.push('edit');
        else if (/^Commit/i.test(s)) cur.tools.push('commit');
        else if (/^(Added|Removed)\b/i.test(s)) cur.tools.push('files');
        else if (/^Running\b/i.test(s)) cur.tools.push('run');
      }
      return;
    }
    if (!cur) cur = { text: '', tools: [] };
    cur.text += (cur.text ? '\n' : '') + line;
  });
  flush();
  const msgs = messages.filter(function (m) { return m.text || m.tools.length; });
  return { messages: msgs, cwd: null, counts: countsOf(msgs) };
}
function dedupe(a) { const seen = {}; return (a || []).filter(function (x) { if (!x || seen[x]) return false; seen[x] = 1; return true; }); }
function countsOf(m) { return { messages: m.length, user: m.filter(function (x) { return x.role === 'user'; }).length, assistant: m.filter(function (x) { return x.role === 'assistant'; }).length }; }

// Normalize a foreign session file into the unified shape. Returns { tool, ...unified } or throws.
function normalize(filePath, text) {
  const tool = detect(filePath, text);
  if (tool === 'jsonl') { const parsed = require('./transcript').parse(text); return Object.assign({ tool: 'jsonl' }, parsed); }
  if (tool === 'aider') { return Object.assign({ tool: 'aider' }, parseAider(text)); }
  throw new Error('unrecognized session format (supported: message-event JSONL, Aider .md)');
}

module.exports = { detect: detect, parseAider: parseAider, normalize: normalize };
