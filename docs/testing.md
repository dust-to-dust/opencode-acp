# Testing Guide

Use the real source implementation in tests. Do not locally reimplement the behavior under test.

## Test Runner

The package test script is `node --import tsx --test tests/*.test.ts`. Run a specific test file with:

```bash
node --import tsx --test tests/<file>.test.ts
```

Use the repository's CI workflow as the source of truth for supported Node versions. Do not encode historical test counts in documentation. Standard project checks are defined by `package.json` and the root development specification.

## Nudge and Growth Tests

Changes to `lib/messages/inject/` or other nudge logic must cover all of the following:

- At least two consecutive `injectCompressNudges` calls sharing one `SessionState`.
- Both the injection decision and relevant side effects after each call, especially `lastPerMessageNudgeTokens` and/or `lastNudgeShownTokens`.
- At least one production-like fixture with `preserveRecentMessages > 0`.
- The complete cycle: baseline, growth, nudge, compression, new baseline, growth, and another nudge.
- A regression test that fails if compression attempts silently reset the baseline incorrectly.

These tests must exercise cross-turn state, not just a single pure decision.

## Coverage and Scope

Before claiming coverage, inspect both the relevant source and test files. In particular, persistence, pruning, synchronization, injection, commands, and UI notification code may require dedicated tests even when integration tests exist.
