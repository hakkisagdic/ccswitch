# Credits

keyflip stands on the shoulders of prior open-source work. This file records
attribution for approaches and ideas we reimplemented.

## CodexBar — multi-provider usage / limit detection

- Project: **CodexBar** — https://github.com/steipete/CodexBar
- Author: Peter Steinberger (@steipete) and contributors
- License: **MIT**

CodexBar is a macOS menu-bar app that surfaces AI coding-provider usage limits
and reset windows across many providers (Codex/OpenAI, Claude, Cursor, Copilot,
Gemini, opencode, OpenRouter, and more) by reading each tool's own local config
/ cache files, running its CLI, or calling its usage API.

keyflip's `src/provusage.js` (a zero-dependency, multi-provider usage/limit
reader) **reimplements the CAPABILITY** of CodexBar — the idea of a normalized,
per-provider registry that detects presence and reads usage windows + reset
times from each provider's own known local surfaces — in original,
zero-dependency Node.js. **No CodexBar Swift source was transliterated.** Only
the approach (which local files/CLIs/endpoints hold usage data, and how to
normalize them into a common "windows + resetsAt" shape) was adapted.

Thank you to the CodexBar authors for mapping out where each provider keeps its
usage data.
