# T11a research policy inventory

Pure kernel implementation of architecture §§4.5, 5.2, 5.4, 8.2, 8.4 and 9.2. Explicit Interpreter requests only; no proactive nominations, Checker or unsolicited speech.

| Policy | Config | Default | Bound |
|---|---|---:|---:|
| JOBS_MAX_CONCURRENT | jobsMaxConcurrent | 2 | 4 |
| JOBS_MAX_QUEUED | jobsMaxQueued | 4 | 16 |
| JOBS_MAX_PER_SESSION | jobsMaxPerSession | 15 | 50 |
| JOB_DEADLINE | jobDeadlineMs | 90,000 ms | 300,000 ms |
| Automatic retries | jobMaxRetries | 1 | 0–1 |
| Recent-success dedupe | jobDedupeWindowMs | 300,000 ms | 3,600,000 ms |
| Per-attempt cost reservation | jobEstimateUsd | $0.10 | $3 |
| Public query length | publicQueryMaxChars | 200 | 2,000 |
| Additional blocked terms | privateTermBlocklist | empty | trusted config |
| Session soft cap | sessionSoftCapUsd | $3 | $20 |
| Session hard cap (research respects the lower soft cap) | sessionHardCapUsd | $5 | $25 |
| Development daily cap | developmentDailyCapUsd | $10 | $50 |

## Conservative implementation choices

- A retry requires `TRANSIENT_FAILURE_PREFIX` (`transient_`) in `research/events.ts`, keeps the job ID and original deadline, and gets a fresh call ID. `transient_provider_failure` qualifies; `permanent_provider_failure`, `permanent_missing_job` and every unknown/non-prefixed reason do not. No partial findings exist in this event contract; a completed finding is terminal and cannot retry.
- Rejected requests have a single truthful refusal, not a second terminal closure. Duplicate requests attach to the existing job's promise and do not repeat its closure.
- Queued work reserves one estimate. Dispatch transfers that reservation to a call; retries reserve another estimate. Missing usage keeps the call reservation, including after timeout, failure and restart. Usage is incremental per event (event IDs deduplicate re-delivery), including costs of retired attempts. The estimate is unmeasured, not a provider-enforced spend cap.
- Global budget aggregates lack a per-call inclusion watermark. The gate conservatively adds all local reservations and local spend since the last aggregate to its totals. This can double-count reservations already included globally (early refusal), but prevents several admissions from reusing stale global headroom. A fresh aggregate checkpoints the session spend; it does not release call reservations. The cross-session ledger itself is outside this task.
- Privacy uses normalized whole terms from every private item's text, including common terms: this deliberately may overblock. It cannot detect paraphrases. Only the public query crosses the dispatch lookup seam.
- Quote provenance is exact URL plus normalized quote substring. The token classes and normalization below are lexical checks, not semantic entailment. No whole-claim token coverage is required; ordinary predicates may paraphrase. Ambiguous/mismatching detected classes stay card-only.
- Claim status is derived from existing support `quoteVerified` flags: a claim with no verified support is citation-only. No model-supplied verification/status field is accepted.
- The job-count cap counts admitted logical jobs, not rejected attempts, duplicates or retries.
- Private/Stop research controls and item deletion remain unbuilt. `researchControlBlock` and `purgeResearchDerivedFrom` are unwired T08 hooks. The purge hook is not a full deletion implementation.
- Current findings enter model context as JSON data only, with question/verdict/verified claim text/URLs/validity. No snippets, quotes, secondary caveats, partial results or stale findings.

## Evidence token classes and normalization

- Quote/snippet normalization: Unicode NFKC, lowercase, curly apostrophes/quotes to straight, Unicode dashes/minus to ASCII `-`, whitespace collapse and trim. URLs are not normalized: they must match exactly.
- Numeric tokens retain signs, `$`/`€`/`£`, decimal/group separators and `%`; whitespace inside a numeric token is ignored. Spelled English cardinal numbers through the tens, scale words, half/quarter and common ordinals are checked too. No unit conversion, currency conversion or numerical equivalence is inferred.
- Quantities retain the adjacent unit/word as a pair, so `12 GB; 15 USD` does not support `15 GB; 12 USD`. Unknown adjacent words are conservatively treated as possible units; this can make valid paraphrases card-only. Common time, storage, rate, currency and count units are also checked independently.
- Names: capitalized, acronym and camel-case tokens, including hyphenated names; contiguous capitalized tokens are checked as a phrase (`Provider A`, not an unrelated article `a`). A small common sentence-word exemption avoids treating `First` or `The` as names. A simple lowercase subject before a recognized predicate is conservatively checked as a potential product name. This is a bounded English lexical heuristic, not exhaustive named-entity recognition or a product dictionary.
- Negations: explicit English negative words and contractions (including curly-apostrophe input) must occur as whole normalized terms. Logical equivalence or implied negation is not inferred.
- Qualifiers beginning `only if`, `only on`, `after`, `before`, `unless`, `on`, `in` or `if` must appear as normalized phrases in the same quote. Qualifiers are not reconstructed from caveats or another claim's support.
- Missing search evidence makes the verdict `not_researched` and all supports unverified. A claim is citation-only when none of its supports pass; the unchanged contract has no separate claim-status field.

`configVersion`: 0.3.7. `REDUCER_VERSION`: 10; old snapshots require the existing explicit mismatch handling.
