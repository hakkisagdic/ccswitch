'use strict';
// Epic F: normalize other agents' session logs into keyflip's unified shape (src/foreign.js).
const test = require('node:test');
const assert = require('node:assert');
const foreign = require('../src/foreign');

const AIDER = [
  '# aider chat started at 2026-07-07 09:00:00',
  '',
  '> Aider v0.50',
  '> Added foo.py to the chat',
  '',
  '#### add a hello function to foo.py',
  '',
  'Sure — here is a hello():',
  '',
  '```python',
  'def hello(): return "hi"',
  '```',
  '',
  '> Applied edit to foo.py',
  '> Commit abc123 add hello',
  '',
  '#### now add a test',
  '',
  'Added a test in test_foo.py.',
].join('\n');

const JSONL = [
  '{"type":"user","cwd":"/p","message":{"role":"user","content":"explain closures"}}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"A closure captures its scope."}]}}',
].join('\n');

test('detect: recognizes aider md, jsonl by extension and by content sniff', function () {
  assert.strictEqual(foreign.detect('.aider.chat.history.md', ''), 'aider');
  assert.strictEqual(foreign.detect('x.md', '# aider chat started at ...'), 'aider');
  assert.strictEqual(foreign.detect('gemini.jsonl', ''), 'jsonl');
  assert.strictEqual(foreign.detect('nohint', '{"type":"user","message":{"role":"user","content":"hi"}}'), 'jsonl');
  assert.strictEqual(foreign.detect('random.txt', 'just prose'), null);
});

test('parseAider: #### = user turns, > = summarized tool lines, other text = assistant', function () {
  const p = foreign.parseAider(AIDER);
  assert.strictEqual(p.counts.messages, 4);
  assert.strictEqual(p.counts.user, 2);
  assert.strictEqual(p.counts.assistant, 2);
  assert.strictEqual(p.messages[0].role, 'user');
  assert.strictEqual(p.messages[0].text, 'add a hello function to foo.py');
  assert.ok(p.messages[1].text.indexOf('def hello()') !== -1, 'code block preserved in the assistant turn');
  assert.deepStrictEqual(p.messages[1].tools, ['edit', 'commit'], 'aider status lines summarized as clean tool labels');
  assert.strictEqual(p.messages[1].text.indexOf('Applied edit'), -1, 'raw > status lines are NOT dumped into the text');
});

test('normalize: jsonl routes through the tested transcript parser', function () {
  const n = foreign.normalize('gemini.jsonl', JSONL);
  assert.strictEqual(n.tool, 'jsonl');
  assert.strictEqual(n.counts.messages, 2);
  assert.strictEqual(n.cwd, '/p');
  assert.strictEqual(n.messages[1].text, 'A closure captures its scope.');
});

test('normalize: aider file yields the unified shape tagged aider', function () {
  const n = foreign.normalize('.aider.chat.history.md', AIDER);
  assert.strictEqual(n.tool, 'aider');
  assert.ok(n.counts.messages === 4 && Array.isArray(n.messages));
});

test('normalize: an unrecognized format throws a clear error', function () {
  assert.throws(function () { foreign.normalize('notes.txt', 'just prose, not a session'); }, /unrecognized session format/);
});

test('the normalized shape feeds straight into the transcript exporter', function () {
  const transcript = require('../src/transcript');
  const n = foreign.normalize('.aider.chat.history.md', AIDER);
  const md = transcript.toMarkdown(n, { id: n.tool });
  assert.ok(md.indexOf('### You') !== -1 && md.indexOf('### Claude') !== -1);
  const html = transcript.toHtml(n, { id: n.tool });
  assert.ok(/^<!doctype html>/i.test(html) && html.indexOf('class="msg u"') !== -1);
});
