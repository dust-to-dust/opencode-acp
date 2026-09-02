# Worklog

## Status

Complete.

## Investigation

- Confirmed Git Bash, OpenCode 1.18.25, Node.js 20.19.0, curl, and GNU timeout are available.
- Installed an isolated Bun 1.4.0 copy under the system temporary directory because Bun was not exposed on the Git Bash PATH.
- Reproduced `Error: ENOENT: no such file or directory, open 'D:\\dev\\stdin'` in scenario 09.
- Confirmed Git Bash converts path-valued environment variables for Windows executables; only paths embedded directly in JavaScript source require correction.
- Corrected the local plugin path with `cygpath -m`; OpenCode now loads the repository build rather than ignoring the MSYS path.
- Reproduced a provider-boundary issue in OpenCode 1.18.25: ACP logged `nudged=true` and persisted `pendingCompression`, but the fake provider never received the newly added synthetic user message.
- Changed dynamic compression guidance to target the latest real user message, which OpenCode forwards to the provider.
- The first rerun still reported no detected request, so provider observations now retain the last user-text tail to distinguish delivery from parsing failures.
- Isolated `XDG_CACHE_HOME` alongside config and data paths.
- Provider observations confirmed the latest-user carrier works. The remaining failure was the fake parser's LF-only regular expression against CRLF prompt assets, so candidate parsing now normalizes line endings.
- Scenario 08 retained a 6000-token growth threshold while its five turns only added about 1100 tokens. Lowered only its nudge threshold to the semantic E2E values while retaining the production protection settings under test.

## Verification

- `tests/inject.test.ts`: 13 tests passed.
- Full tracked unit suite: 810 tests passed, 0 failed.
- TypeScript `--noEmit`: passed.
- Production build: passed.
- Prettier and `bash -n scripts/e2e/run-e2e.sh`: passed.
- Representative scenario 09: 6 assertions passed, including one visible `compress` call and one active block.
- Full fake-model E2E suite: 4 scenarios passed (`06`, `08`, `09`, and `10`), 0 failed.

## Session Visibility Follow-up

- OpenCode had two project IDs for `D:/prj/opencode-acp` because the Git remote changed from `github.com/ranxianglei/opencode-acp` to `github.com/dust-to-dust/opencode-acp`; old sessions remained under the former ID and were hidden by the project-scoped session list.
- Backed up the real database to `C:\Users\24185\.local\share\opencode\opencode-before-session-repair-20260831.db`, migrated 12 sessions to the current project ID, and removed the stale project record. No session messages or ACP state files were deleted.
- Updated `scripts/e2e/run-e2e.sh` to run OpenCode from `/tmp/acp-e2e/project`, preventing E2E runs from changing the real repository's `.git/opencode` cache.

## Stable Model-Facing References

- Changed generated activity and checkpoint refs from padded forms such as `A005` and `B001` to canonical forms such as `A5` and `B1`.
- Kept canonical refs in `state.messageIds.byRawId` immutable when messages are pruned and later reloaded. Existing persisted sessions are not migrated to the new reference format.
- Added coverage for ref stability across pruning and tool-result rejoining, canonical formatting, and rejection of old padded refs.
- Full tracked unit suite: 813 tests passed, 0 failed.
