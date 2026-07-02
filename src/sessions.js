'use strict';
// Session manager: browse/search/resume local Claude Code conversations across
// ALL accounts (transcripts in ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
// are account-independent). Read-only; nothing is uploaded.
const fs = require('fs');
const path = require('path');

function projectsDir(ctx) { return path.join(ctx.claudeDir || path.join(ctx.home, '.claude'), 'projects'); }

// Pull the first-line cwd and the first user message text from a transcript,
// reading only the head of the file (transcripts can be large).
function summarize(file) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    head = buf.slice(0, n).toString('utf8');
  } catch (e) { return null; }
  let cwd = null, preview = null;
  const lines = head.split('\n');
  for (let i = 0; i < lines.length && (!cwd || !preview); i++) {
    if (!lines[i].trim()) continue;
    let j; try { j = JSON.parse(lines[i]); } catch (e) { continue; }
    if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
    if (!preview && j.type === 'user' && j.message && j.message.content) {
      const c = j.message.content;
      const text = typeof c === 'string' ? c : (Array.isArray(c) ? (c.filter(function (b) { return b && b.type === 'text'; })[0] || {}).text : null);
      if (text) preview = String(text).replace(/\s+/g, ' ').trim().slice(0, 100);
    }
  }
  return { cwd: cwd, preview: preview };
}

// List sessions, newest first. opts: { cwd, search, limit }.
function list(ctx, opts) {
  opts = opts || {};
  const root = projectsDir(ctx);
  let projectDirs = [];
  try { projectDirs = fs.readdirSync(root); } catch (e) { return []; }
  const rows = [];
  const wantCwd = opts.cwd ? path.resolve(opts.cwd) : null;
  projectDirs.forEach(function (pd) {
    const dir = path.join(root, pd);
    let files;
    try { files = fs.readdirSync(dir); } catch (e) { return; }
    files.forEach(function (f) {
      if (f.slice(-6) !== '.jsonl') return;
      const id = f.slice(0, -6);
      // Must start alphanumeric (a leading '-' would smuggle a flag into
      // `claude --resume <id>`) and contain only safe id chars.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return;
      const file = path.join(dir, f);
      let st; try { st = fs.statSync(file); } catch (e) { return; }
      rows.push({ sessionId: f.slice(0, -6), file: file, project: pd, mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString(), sizeBytes: st.size });
    });
  });
  rows.sort(function (a, b) { return b.mtimeMs - a.mtimeMs; });

  // Enrich (head-read) only as many as we might show — cheap for a listing,
  // bounded for a search. For --search we may need full-content scanning.
  const scanLimit = opts.search ? (opts.scanLimit || 800) : (opts.limit || 40) * 3;
  const out = [];
  for (let i = 0; i < rows.length && out.length < (opts.limit || 40); i++) {
    if (i >= scanLimit && !opts.search) break;
    const r = rows[i];
    const s = summarize(r.file) || {};
    r.cwd = s.cwd || decodeProjectDir(r.project);
    r.preview = s.preview || '';
    if (wantCwd && path.resolve(r.cwd || '') !== wantCwd) continue;
    if (opts.search && !matchesSearch(r, opts.search)) continue;
    out.push(r);
  }
  return out;
}

function decodeProjectDir(name) {
  // best-effort: dashes were slashes; leading dash = root. Not lossless.
  return name.replace(/^-/, '/').replace(/-/g, '/');
}

function matchesSearch(row, term) {
  const t = String(term).toLowerCase();
  if ((row.preview || '').toLowerCase().indexOf(t) !== -1) return true;
  if ((row.cwd || '').toLowerCase().indexOf(t) !== -1) return true;
  if (row.sessionId.toLowerCase().indexOf(t) !== -1) return true;
  // deeper: scan the file content, but bounded — read at most the first 1 MB so a
  // huge/hostile transcript can't exhaust memory.
  try {
    const fd = fs.openSync(row.file, 'r');
    const buf = Buffer.alloc(1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8').toLowerCase().indexOf(t) !== -1;
  } catch (e) { return false; }
}

// Find one session by id (full or unique prefix).
function find(ctx, idOrPrefix) {
  const all = list(ctx, { limit: 100000 });
  const exact = all.filter(function (r) { return r.sessionId === idOrPrefix; })[0];
  if (exact) return exact;
  const pref = all.filter(function (r) { return r.sessionId.indexOf(idOrPrefix) === 0; });
  if (pref.length === 1) return pref[0];
  if (pref.length > 1) throw new Error("'" + idOrPrefix + "' is ambiguous (" + pref.length + ' sessions) — use more of the id');
  return null;
}

// The command that resumes a session in its original directory.
function resumeCommand(row) {
  return { cwd: row.cwd, command: 'claude', args: ['--resume', row.sessionId] };
}

module.exports = { projectsDir: projectsDir, list: list, find: find, summarize: summarize, resumeCommand: resumeCommand, decodeProjectDir: decodeProjectDir };
