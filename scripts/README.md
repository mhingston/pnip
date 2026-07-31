# PNIP scripts

The daily publication script runs the bounded, deterministic workflow:

1. recover discovery and process pending extraction/enrichment;
2. roll incomplete documents to the next mutable edition;
3. compose the frozen edition with `compose-edition`;
4. process source-grounded story summaries;
5. render Markdown/email/NotebookLM artifacts and publish.

Run a composition check directly with:

```bash
npm run digestive -- compose-edition --date YYYY-MM-DD
```

Optional external outputs remain retryable and do not invalidate the canonical
Markdown digest.
