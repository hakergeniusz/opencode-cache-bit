# opencode-cache-bit

Native **OpenCode V2** port of the pi extension [`pi-cache-bit`](https://github.com/hakergeniusz/pi-cache-bit).

It reports the **prompt-cache hit rate** — globally and in the current session — calculated from raw per-call token usage with the same formula as the original:

```
prompt tokens  = input + cacheRead + cacheWrite
cache-hit rate = cacheRead / promptTokens * 100
```

`input` is uncached, `cacheRead` is the hit, and `cacheWrite` primes the cache for the next turn. This measures cache-hit *rate* (tokens served from cache); it is not a cache-miss diagnostic.

## Load

Add the plugin to `opencode.json(c)` (or drop the directory into `.opencode/plugins/`):

```jsonc
{
  "plugins": ["opencode-cache-bit"]
}
```

Options use the object form:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-cache-bit",
      "options": {
        "defaultScope": "all",      // "all" | "session" | "global"
        "globalCacheTTLMs": 300000, // reuse the stored global aggregate for 5 min
        "maxSessions": 2000         // safety cap for a global recount
      }
    }
  ]
}
```

## Use

- `/cache-bit` — both sections (default).
- `/cache-bit session` — only the live session.
- `/cache-bit global` — only the global aggregate.
- `/cache-bit --rebuild` — force a fresh recount of every session before reporting (`rebuild` also works).

A read-only `cache_bit` tool is also registered so the model can request the same report (`scope: "all" | "session" | "global"`, `rebuild: boolean`).

Example output:

```
Cache hit rate
  50.0% cache-hit  (this session)
    50.0% cache-hit  (3,000 cache-read of 6,000 prompt tokens)
    ↑3,000 in · ↓1,000 out · 3,000 cache-read · 0 cache-write · 7,000 total · $0.07 · 1 req · anthropic/claude-3
  95.0% cache-hit  (global, ledger)
    1,900 cache-read of 2,000 prompt tokens
    across 120 sessions
    ledger updated 11/19/2026, 10:00:00 PM
```

## How it maps from the pi original

| pi original | OpenCode V2 port |
|---|---|
| `pi.registerCommand("cache-bit", …)` | `ctx.command.transform(editor => editor.add({ name: "cache-bit", execute }))` |
| Command args parsed from the raw string | `execute({ sessionID, prompt })` parses `prompt.text` the same way |
| Live tally from `ctx.sessionManager.getEntries()` | `fetchMessages()` reads `ctx.session.messages` / `ctx.session.context({ sessionID })` and runs `scanEntries()` |
| Global tally from `pi-token-usage`'s `~/.pi/agent/token-usage.json` ledger | Global aggregate stored in `ctx.storage` under `global-totals`, with a configurable TTL |
| `/cache-bit --rebuild` → `SessionManager.listAll()` + recount | `scanGlobal()` pages through `ctx.session.list()` and recounts each session's messages |
| `pi.appendEntry("cache-bit-report", …)` + `ctx.ui.notify` / print-mode stdout | `ctx.session.synthetic({ sessionID, text, resume: false })` appends a plain-text report to the transcript; the tool returns the same text |
| `pi.registerEntryRenderer` with `pi-tui` `Box`/`Text` | Not portable — see gaps |
| `PI_CACHE_BIT_LEDGER` env override | `ctx.options` (set via the `plugins` object form) |

The token math, report layout, and formatting are shared with the original; pure logic lives in `src/totals.ts` and `src/report.ts` with no runtime SDK imports. The scanner accepts both pi usage shapes (`{ input, output, cacheRead, cacheWrite, totalTokens, cost }`) and OpenCode's (`tokens: { input, output, reasoning, cache: { read, write } }` plus a numeric `cost` on the message info). OpenCode reasoning tokens are folded into `output` for comparability.

## Known gaps / differences

- **No external ledger.** OpenCode has no `pi-token-usage` extension or `token-usage.json`. The "ledger" is this plugin's own `ctx.storage` aggregate; the first run computes it by scanning sessions (reported as `global, recount`) and later runs within the TTL report `global, ledger`. `--rebuild` always rescans.
- **No custom transcript renderer.** pi's `registerEntryRenderer` + `pi-tui` `Box`/`Text` styling has no server-side equivalent, so the report is a plain-text synthetic message rather than a styled custom entry. No separate toast is emitted.
- **No print-mode branch.** `ctx.mode === "print"` does not exist in the plugin context; output always goes to the transcript (or the tool result). If synthetic messages are unavailable, the report falls back to the OpenCode server log.
- **No argument completions.** pi's `getArgumentCompletions` is not available; slash arguments are plain text.
- **Context window limitation.** `ctx.session.context()` covers messages after the last compaction; the recount prefers the full `session.messages` API when the installed OpenCode exposes it and falls back to `context()` otherwise. Very old history may therefore be undercounted on builds without the message-list API.
- **No TUI part.** This is a server-only plugin; no `src/tui.tsx` is shipped.

## Tests

The original extension's smoke test had meaningful, dependency-free assertions for the hit-rate math, entry scanning/aggregation, report sections, and argument parsing. Those pure cases are ported to `test/totals.test.ts` (`bun test`). The fake-`ExtensionAPI` command test could not be ported without pi runtime types; it is replaced with direct `buildReport()` assertions.

```bash
bun test
```
