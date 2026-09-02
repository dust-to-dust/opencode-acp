# Windows E2E Runner Compatibility

## Problem

The fake-model E2E runner fails under Git Bash when it invokes Windows Node.js because `/dev/stdin` is interpreted as `D:\dev\stdin`. Absolute MSYS scenario paths embedded inside JavaScript source are also not converted for Windows Node.js.

## Acceptance Criteria

- The representative fake-model scenario runs successfully from Git Bash with Windows OpenCode, Node.js, and Bun executables.
- Scenario JSON is read through a native command argument rather than interpolated into JavaScript source.
- Standard input is read through file descriptor `0`, which works on Unix and Windows.
- The E2E environment remains isolated under `/tmp/acp-e2e` and does not modify the installed ACP package cache.
- The E2E runner does not modify the real repository's `.git/opencode` project identity cache.
- Compression guidance reaches the fake provider on OpenCode 1.18.25 and drives a real `compress` tool call.

## Constraints

- Keep runtime changes limited to the message that carries dynamic compression guidance.
- Do not add runtime dependencies.
