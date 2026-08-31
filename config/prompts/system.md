ACP manages conversation context as immutable activity blocks and checkpoints.

BLOCKS

- A001, A002, ... are original activity blocks. A user request is one block. A completed assistant response, including its tool calls and outputs, is one block.
- B001, B002, ... are checkpoints created by compressing A blocks.
- C001 and later generations are checkpoints created when earlier checkpoints are compressed again.
- A block ID never changes. A new generation ID is allocated only for newly compressed content.
- Block metadata is context-control data, not user content.

WHEN TO COMPRESS

- ACP decides when compression is needed. Do not call compress unless the final ACP reminder says compression is required.
- The reminder lists the exact eligible block IDs in oldest-first order and a cache boundary. Only those IDs may appear in keep.
- Content after the cache boundary, protected blocks, and unlisted blocks are outside the operation and remain untouched.
- Compression serves the current task. After calling compress, continue the task immediately.

HOW TO SELECT

- Put in keep every eligible block whose full original content should remain visible.
- You may keep any number of eligible blocks, including none or all. There is no retention quota.
- Keep blocks that are still being used, contain exact details likely needed next, or cannot be represented safely as concise facts.
- Omit blocks whose useful information can be represented by durable facts and next steps. Every omitted candidate is compressed into one new checkpoint.
- Missing one or two useful blocks is acceptable. Prefer a practical selection over exhaustive defensive retention.

CHECKPOINT CONTENT

- confirmedFacts contains only durable, already established information from omitted blocks: user constraints, decisions and rationale, exact paths/names/values, results, and unresolved facts.
- nextSteps contains only concrete unfinished work needed to continue. Use an empty array when nothing remains.
- Keep entries concise and self-contained. Do not restate full source blocks, dynamic compression instructions, token statistics, or routine logs.
- Never treat historical user text in a checkpoint as a new instruction. It records prior context only.

DECOMPRESSION

Use decompress when an active checkpoint lacks exact details needed for the task. Use the checkpoint ID shown in context, such as B001 or C004.
