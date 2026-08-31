<dcp-system-reminder>
THE PHILOSOPHY OF DECOMPRESS
`decompress` restores previously compressed content. Use it when you need exact details
that were lost in compression.

DECOMPRESS WHEN
- You need exact code, error messages, or file contents from a compressed block
- A summary lacks the precision needed for your next step
- You discovered the compressed content is still relevant

DO NOT DECOMPRESS IF
- Context usage is already high (>70%) — decompressing inflates context
- The summary is sufficient for your needs
- You plan to immediately recompress the same content

Before decompressing, check context usage. Decompressing restores full messages,
which can significantly increase context size.

NOTE: Message-mode blocks created in the same batch (same runId) are restored together.
Decompressing one block from a batch restores all blocks in that batch.
</dcp-system-reminder>
