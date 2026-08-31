# Development Specification

> This file is the always-loaded project contract. Follow it for every change.
> 在存在规则冲突时，提醒用户，并以用户最新指令为准

## 1. Scope and Source of Truth

ACP (Active Context Pruning) is an OpenCode plugin that gives the model a `compress` tool for model-driven, recoverable context management.

- Language/runtime: strict TypeScript, ESM, Node.js.
- Build: `tsup` plus `tsc --emitDeclarationOnly`.
- Tests: Node's built-in runner with `tsx`.
- Package manager: npm.
- Formatting: Prettier.
- Runtime behavior is defined by the current source, schemas, and package assets. Do not copy defaults or behavior from stale documentation.
- Do not add runtime dependencies without an explicit requirement.

Task-specific references (read only when relevant):

- Architecture and data flow: `./docs/architecture.md`
- Testing and test review: `./docs/testing.md`
- Local build, deployment, and diagnostics: `./docs/development.md`
- Stable, prerelease, and fallback publishing: `./docs/release.md`
- Requirement and worklog format: `./devlog/README.md`

## 2. Non-Negotiable Runtime Invariants

- Preserve the message-transform pipeline order unless the dependency between every affected step is understood and tested. The broad order is: resolve session state, update turn state, clean stale references, assign activity references, sync checkpoints, run GC, prune, inject semantic compression nudges, inject IDs, then strip stale metadata.
- Session state is per session and includes compression blocks, nudge state, token statistics, raw-ID/reference mappings, timing, and tool-parameter caches. Persistence and state mutations must not lose existing data.
- Protected tools, protected file patterns, protected user messages, and other configured protected content must not be accidentally pruned. Protected tool messages must be hard-excluded from semantic candidate sets, not merely mentioned in checkpoint summaries.
- Preserve tool-use/tool-result pairing and the first-user-message invariant when changing message filtering or semantic candidate selection.
- Internal DCP-compatible names are persisted or shown to models. Do not rename `dcp-message-id`, `dcp-system-reminder`, `DCP_*` compatibility identifiers, or `dcp.schema.json` without a migration plan. User-visible naming remains ACP/acp.
    
## 3. Coding and Verification Rules

- Follow the existing parameter-passing pattern: modules receive configuration, session state, and logger explicitly; do not introduce global mutable singletons.
- Keep changes minimal and local. Do not use `as any`, `@ts-ignore`, or type-assertion hacks to bypass the type system.
- Add or update tests for behavior changes. Tests must import the real implementation and make meaningful assertions.

## 4. Git, Devlog, and PR Safety

- Normal branch names match `YYYY-MM-DD_short-title`. Create a matching `devlog/<branch-name>/` entry before implementation.
- Every PR includes `REQ.md` and `WORKLOG.md`; add `DESIGN.md` for architecture, data-flow, or module-boundary changes. Update the worklog during and after implementation.
- Do not delete branches or tags without human confirmation.
- Do not modify `package.json`'s `version` on non-release branches.
- Use descriptive commit messages. Follow the release guide for release-specific branch and publishing rules.
