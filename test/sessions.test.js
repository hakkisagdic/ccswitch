'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sessions = require('../src/sessions');
const { makeCtx } = require('./helpers');

function seedSession(ctx, project, id, cwd, firstUserText, mtimeMs) {
  const dir = path.join(ctx.home, '.claude', 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, id + '.jsonl');
  const lines = [
    JSON.stringify({ type: 'queue-operation', sessionId: id, timestamp: '2026-07-01T00:00:00Z' }),
    JSON.stringify({ type: 'user', sessionId: id, cwd: cwd, message: { role: 'user', content: [{ type: 'text', text: firstUserText }] } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  if (mtimeMs) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('list finds sessions across projects, newest first, with cwd + preview', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-proj-a', '11111111-aaaa', '/proj/a', 'help me with auth', Date.now() - 100000);
  seedSession(ctx, '-proj-b', '22222222-bbbb', '/proj/b', 'fix the parser', Date.now());
  const rows = sessions.list(ctx, {});
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].sessionId, '22222222-bbbb'); // newest first
  assert.strictEqual(rows[0].cwd, '/proj/b');
  assert.match(rows[0].preview, /fix the parser/);
});

test('--search matches preview, cwd, id, and deep content', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-p', 'aaaa1111', '/work/x', 'implement OAuth flow');
  seedSession(ctx, '-p', 'bbbb2222', '/work/y', 'unrelated');
  assert.strictEqual(sessions.list(ctx, { search: 'oauth' }).length, 1);
  assert.strictEqual(sessions.list(ctx, { search: '/work/y' }).length, 1);
  assert.strictEqual(sessions.list(ctx, { search: 'aaaa1111' }).length, 1);
  assert.strictEqual(sessions.list(ctx, { search: 'nomatch' }).length, 0);
});

test('--cwd filters to a directory', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-a', 's1', '/here', 'x');
  seedSession(ctx, '-b', 's2', '/there', 'y');
  const rows = sessions.list(ctx, { cwd: '/here' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sessionId, 's1');
});

test('find resolves a unique id prefix and errors on ambiguity', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-p', 'abc111', '/x', 'a');
  seedSession(ctx, '-p', 'abc222', '/x', 'b');
  seedSession(ctx, '-p', 'zzz999', '/x', 'c');
  assert.strictEqual(sessions.find(ctx, 'zzz999').sessionId, 'zzz999');
  assert.strictEqual(sessions.find(ctx, 'zzz').sessionId, 'zzz999');
  assert.throws(function () { sessions.find(ctx, 'abc'); }, /ambiguous/);
  assert.strictEqual(sessions.find(ctx, 'nope'), null);
});

test('resumeCommand builds `claude --resume <id>` in the original cwd', function () {
  const ctx = makeCtx();
  seedSession(ctx, '-p', 'sess-1', '/my/dir', 'go');
  const rc = sessions.resumeCommand(sessions.find(ctx, 'sess-1'));
  assert.deepStrictEqual(rc, { cwd: '/my/dir', command: 'claude', args: ['--resume', 'sess-1'] });
});
