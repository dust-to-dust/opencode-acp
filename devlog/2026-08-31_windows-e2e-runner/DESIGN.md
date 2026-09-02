# Design

## Decision

Append dynamic compression guidance to the latest real user message instead of adding a synthetic user message to the transformed message array.

## Rationale

OpenCode 1.18.25 accepts mutations to messages loaded from session history but omits newly added messages when it builds the provider payload. The previous implementation persisted `pendingCompression` and reported `nudged=true`, while the provider never received `[ACP compression required]`.

The latest user message is the uncached tail of the current request. Appending guidance there preserves older cacheable history, works during subsequent tool-loop iterations, and does not persist the injected text to session storage.

## Scope

- Reuse the latest user message as the guidance target.
- Add a deterministic synthetic text part only when that message has no text part.
- Keep candidate selection, pending-state persistence, and prompt rendering unchanged.
