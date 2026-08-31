THE FORMAT OF COMPRESS

```
{
  topic?: string,          // OPTIONAL fallback topic for entries without their own.
                           //   Omit when every content entry specifies its own topic.
  content: [               // One or more ranges to compress
    {
      topic?: string,      // OPTIONAL per-entry topic for this range.
                           //   Falls back to top-level topic.
                           //   Give each entry its own topic when compressing
                           //   unrelated ranges in one call.
      startId: string,     // Boundary ID at range start: mNNNNN or bN
      endId: string,       // Boundary ID at range end: mNNNNN or bN
      summary: string      // Complete technical summary replacing all content in range
    }
  ]
}
```
Each entry needs a topic — either its own or the top-level fallback.
