Compression Philosophy:
- All compression serves the primary task, but be frugal.
- Context capacity is precious. Save context by compressing consumed outputs, not by avoiding tools.
- Compress by need, not by percentage.
- Work from summaries, not raw tool outputs. All listed ranges (user prompts, tool outputs, code, logs, exploration, intermediate steps) should be compressed to summary format — the ONLY exceptions are protected content, content the current step is actively using, or critical content you cannot reconstruct.
- Curate summaries like a well-structured document. User prompts, compressed tool outputs, code, logs, or skill-call intermediate results that are critically important should be preserved — not by exempting them from compression, but by embedding them in the summary via [[KEEP:mNNNNN]] (auto-expanded verbatim) and [[REF:mNNNNN|description]] (compact link).
