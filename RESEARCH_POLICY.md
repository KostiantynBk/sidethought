# Research and contribution policy

Sidethought can research an explicit request or a Deliberator nomination. The Deliberator proposes public
queries and ideas; deterministic admission, evidence checks and delivery gates decide what happens next.
These controls reduce risk but do not guarantee privacy, truth, relevance or a spoken contribution.

## Search and admission

The Investigator receives a public query, not the project's conversation or reviewed lessons. Privacy
filtering is lexical and can overblock or miss paraphrases; do not enter secrets or sensitive information.
Some nominations require user approval, including follow-up investigations and those needing private detail.
Research is subject to scope, dependency, duplicate, queue and budget checks.

Default limits (`src/config/index.ts`) include two concurrent jobs, four queued jobs, 15 admitted jobs per
project session, a 90-second job deadline, at most one retry and a five-minute recent-success deduplication
window. The default per-attempt reservation is $0.10; it is an estimate, not a provider-enforced cap.
Search uses background-mode Meta `web_search` with up to three tool calls; a tool call can issue multiple
queries. Available query counts are metered; missing query details are estimated conservatively.
Cancellation and provider billing are best effort. See [META_POLICY.md](META_POLICY.md) for model limits and prices.

## Page fetching and evidence

After search, the Investigator selects up to six distinct search-result URLs, prioritizing those cited in the
answer, and fetches them concurrently before structuring. It supplies bounded extracted page text as untrusted
source data alongside search results and the answer. It reuses the fetched text to add quote-containing
excerpts to evidence; replay uses journaled evidence and does not refetch pages.

- Fetches use HTTP or HTTPS, default ports and no URL credentials. Every redirect is revalidated, with at most
  three redirects. All resolved addresses must pass public-address checks; connections use a validated pinned
  address, not a later DNS lookup. The fetcher does not use environment proxies.
- Requests use fixed headers and do not add project text, cookies or Meta credentials. Each page is bounded to
  five seconds and 2 MiB; the job deadline and cancellation also apply. DNS lookup itself cannot be cancelled.
- Only successful HTML, XHTML or plain-text responses are accepted; compressed responses are rejected. The
  extractor is not a browser: it does not run JavaScript, render CSS or extract PDFs. Blocked, failed and
  unsupported pages provide no page excerpts. Some public addresses are intentionally overblocked.
- Up to 4,000 characters per page and 20,000 total are selected for structuring using public query terms.
  Retained quote excerpts are bounded and taken from extracted text rather than synthesized.

A claim's support is verified only if a completed search exists, its nonempty quote occurs after normalization
in a retained evidence snippet with the exact same URL, and lexical claim-consistency checks pass. Evidence can
include a provider result snippet or a fetched-page excerpt: a verified flag alone does **not** prove an
independent page fetch. Provider snippets were empty in observed live runs, so fetched pages were important
there. Missing evidence yields `not_researched`; claims without verified support remain citation-only.
A matching quote does not establish semantic entailment or source truth.

The consistency checks cover detected numbers, units, names, negations and qualifiers using bounded lexical
heuristics. They can reject legitimate paraphrases and can miss unsupported implications. Source text is
untrusted data, not instructions. Sites can block fetching or return unusable content. Robots.txt handling is
deferred; the fetcher is not a general crawler.

## Research-backed ideas and Checker

The Deliberator can nominate an independent insight citing `findingIds`. Code rejects a cited finding that is
missing, not current, or has no usable quote-verified, consistent claim. An inconclusive finding may still
provide a verified fact for an idea; `not_researched` cannot. Cited research and its caveats are supplied to
the Checker as data, while the idea remains a suggestion, not a verified finding.

Before an eligible unprompted contribution is delivered, the Checker assesses applicability against the
current snapshot. Code also checks revision and input changes, dependencies, sentence count, credentials,
URLs and lexical support. Research-backed ideas can list only claim IDs from their cited research. Each
sentence must pass both a union-of-basis check and a per-finding support-group check, plus the unsupported-word
check. These are lexical safeguards, not a proof of semantic entailment or correct attribution.
Failed or timed-out checks can become cards; floor and pacing rules still apply after a successful check.
Research and useful unsolicited speech are not guaranteed on cue. General project/session deletion and
Hold/Mute controls are not built; see the README for other limitations.
