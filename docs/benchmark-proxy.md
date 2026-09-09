# Sprint 2 — Proxy Compression Benchmark

Proxy intercepts POST /v1/messages and compresses content blocks before they reach
the Anthropic API. Measured with char-based token approximation (~4 chars/token).

## Results (2026-08-22)

| Input                          | Raw     | Compressed | Savings |
|--------------------------------|---------|------------|---------|
| Build log (npm install)        | 1276 tok | 79 tok    | **-94%** |
| Git diff (large context)       | 180 tok  | 83 tok    | **-54%** |
| JSON API response (50 items)   | 1026 tok | 125 tok   | **-88%** |
| System prompt (150 lines)      | 2400 tok | 261 tok   | **-89%** |
| Realistic session (kubectl)    | 1451 tok | 116 tok   | **-92%** |
| **Total**                      | **6333 tok** | **664 tok** | **-90%** |

## Compressor breakdown

| Type  | Technique                                      |
|-------|------------------------------------------------|
| log   | keeps ERROR/WARN/FATAL + stack traces; elides INFO/DEBUG |
| diff  | keeps headers + changed lines; elides excess context |
| json  | collapses arrays to 3 items; truncates long strings |
| code  | keeps imports + signatures; elides bodies > 4 lines |
| text  | collapses blank runs; head+tail for long docs   |

## Architecture

- `src/proxy/detect.js` — structural type detection (diff/log/json/code/text/short)
- `src/proxy/compress/` — per-type compressors
- `src/proxy/server.js` — HTTP proxy (port 41474, falls back to a free one), intercepts /v1/messages
- `src/proxy/state.js` — on-disk state, TCP liveness probe, generated shell snippet
- `src/proxy/daemon.js` — supervisor (start/stop/restart/status) + guarded shell rc wiring
- Install wires daemon start + env automatically — zero manual steps

## Notes

- Token approximation: `Math.ceil(chars / 4)` — accurate for all content types
  (previous `countTokensApprox` word-split failed on minified JSON, returning 1 token)
- Guard: `if (compressed.length >= input.length) → return original` (char-based, not word-based)
- Streaming responses: proxied via `upstreamRes.pipe(res)` — SSE works transparently
