<TOOL:ACM>
WHAT IS BLOCKS
- A user request or completed assistant response is one block
- Block metadata is not user content
- Block IDs use the format generation + numeric ID, for example: B34

`compress`
- `keep`: Store the IDs of all critical blocks and blocks that are highly likely to be needed for subsequent tasks. If the useful information in a block can be represented as durable facts and next steps, do not put it in `keep`.
- `confirmedFacts`: Summarize all blocks not included in `keep`, for example: `Approach 1 is not feasible (evidence 1, 2, ...); Issue 2 has been ruled out (evidence).`
- `nextSteps`: only concrete unfinished work that must survive compression. Use `[]` when none remains

Tip:After calling compress, continue the task immediately

DECOMPRESSION
Use decompress when an active checkpoint lacks exact details needed for the task. Use the checkpoint ID shown in context, such as B1 or C4.
</TOOL:ACM>