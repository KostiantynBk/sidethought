# Sidethought

Sidethought is a text-first thinking partner for solo builders that remembers named projects and can speak up on its own when something matters. It combines background reasoning, live web research with quote-verified sources, and explicitly reviewed lessons from other projects. Its dependency-aware checks are designed to suppress advice when its basis changes, rather than keep repeating an obsolete point.

## Built and planned

**Built:** text conversation; named projects; reviewed cross-project lessons; a background Deliberator that starts its
own research and turns finished research into its own idea ("I checked: … so I'd …"); unprompted contributions
gated by a final Checker, with each unprompted remark saying why it spoke now; web research with independently
fetched page quotes; finding cards; dependency-based stale checks, including plain-language corrections
such as "Actually, we'll use Pro" (saved in 5 of 7 live tests; see Limitations); old-project upgrade by
journal replay; and optional
read-aloud of new replies and unprompted remarks (browser speech synthesis).

**Planned:** voice input and spoken turn-taking, broad automatic memory, general project/session deletion (T08), and Hold/Mute controls. This is a prototype, not a production service.

## Quick start

Requirements: Node 24, npm, and a platform-compatible prebuilt `better-sqlite3` binary. From this repository:

```sh
npm ci --ignore-scripts
```

Copy `.env.example` to `.env` and configure the following **server-side** variables; do not share or commit `.env`:

- Required: `SIDETHOUGHT_PASSCODE`, `SIDETHOUGHT_COOKIE_SECRET` (at least 32 characters), `SIDETHOUGHT_ALLOWED_ORIGINS` (comma-separated exact origins).
- For Meta: `MODEL_API_KEY`, optionally `SIDETHOUGHT_MODEL`. Without a key, the default dev model is network-free and synthetic; it cannot demonstrate live research or real model quality. An explicit dev selection remains network-free even if a key is present.
- Optional: `PORT`, `SIDETHOUGHT_DB_PATH`, `SIDETHOUGHT_BANNER` (plain-text workspace notice, up to 300
  characters), `META_API_BASE_URL`, `META_INPUT_USD_PER_MILLION`, `META_CACHED_INPUT_USD_PER_MILLION`,
  `META_OUTPUT_USD_PER_MILLION`, `NODE_ENV`. For **local HTTP on 127.0.0.1 only**, enable
  `SIDETHOUGHT_DEV_INSECURE_COOKIE`; never enable it for public or tailnet access. See `.env.example`
  for the variable names.

```sh
npm run build
npm start
```

Open the app at the configured local address and port (default port: 3000), and enter your passcode. The exact browser origin must be in `SIDETHOUGHT_ALLOWED_ORIGINS`. The server binds to 127.0.0.1; remote access requires a separately configured HTTPS proxy. This is a single-owner workspace, not a multi-user service.

**A second, separate instance (e.g. for judges).** `npm run start:judge` loads `.env` and then `.env.judge` (git-ignored; it must exist), whose values win. Give it its own `PORT`, `SIDETHOUGHT_DB_PATH`, `SIDETHOUGHT_PASSCODE`, `SIDETHOUGHT_COOKIE_SECRET` and its public HTTPS origin in `SIDETHOUGHT_ALLOWED_ORIGINS`, and set `SIDETHOUGHT_DEV_INSECURE_COOKIE=0`. Never point it at your personal database. Spend caps apply per project, so total spend grows with the number of projects created.

## A five-minute tour

Use Meta mode for live behavior; research and unsolicited contributions are not guaranteed to appear on cue.

1. **Create a project.** Describe a plan with a real tension, such as keeping notes only on one phone while expecting recovery after losing it. Continue normally, then pause without asking for a risk assessment: the background Deliberator may raise a relevant checked remark.
2. **Let it research on its own.** State a plan that rests on a public fact you have not checked, for example: "I will host the database on the Supabase free tier and rely on its automatic daily backups." Then wait. Sidethought may start a background check by itself, say what it verified, and then offer its own idea, citing that research. None of this is guaranteed on cue.
3. **Ask for a check.** Type “Check whether …” about a concrete public question. Watch for the **Checking…** line and then a finding card. Open its sources and distinguish verified quotes from citation-only claims; a check can be inconclusive or fail.
4. **Try correcting the plan.** For example, say "Actually, we will use the Supabase Pro plan from day one."
   Inspect **Project** and the finding cards, not just the reply: the free-tier item should show as rejected
   or superseded, a Pro decision should appear, and findings built on the free tier should be marked stale
   (or their research cancelled). This worked in 5 of 7 live tests; when it does not, older advice can stay
   current, so trust the Project panel rather than a conversational acknowledgment.
5. **Save a lesson in project A.** Enter a distinctive experience, for example: "Our field-notes pilot lost
   exactly 47 minutes of observations when the only tablet failed. We learned to verify a second independent
   copy before fieldwork." In **Reviewed cross-project lessons**, select that user message, review its exact
   quote and lesson text, enter applicability terms such as `fieldwork, field notes, tablet`, and explicitly
   confirm sharing. Saving is manual; the conversation alone does not share a lesson.
6. **Try project B.** Create a separate project, turn cross-project recall ON, and describe a matching situation
   without repeating the source fact: "We will record all our field notes on a single tablet and copy them to
   the office computer after we get back." A live test recalled the 47-minute loss with attribution to project A
   in the foreground reply. Check **Recently supplied** for context-supply provenance, not proof of useful use.
   The lesson is experience to consider, not evidence or a decision. An unprompted lesson remark is possible
   but was not observed in this test; an attributed reply does not prove asynchronous initiative.
7. **Read aloud.** Turn on **Read aloud** in the header to hear new replies and delivered unprompted remarks (browser speech; off by default). Typing stops it. It never reads cards, web quotes or history, and it can lag behind the text: delivery is tracked by displayed text, not finished speech.

## How it uses Meta

The server uses `muse-spark-1.3` through Meta's Responses API. Interpreter extracts project changes, Responder answers, Deliberator nominates possible contributions, Checker reviews unprompted contributions, and Investigator conducts focused research. Structured roles use strict JSON-schema outputs; the Responder streams text. Reasoning effort is **minimal** for Interpreter, Responder and Checker; **medium** for Deliberator; and **medium** for Investigator search followed by **minimal** for structuring. Search uses background-mode `web_search` and supports cancellation; cancellation and billing are best effort.

Configured list-price defaults: $1.25 per million input tokens, $0.15 per million cached input tokens, $4.25 per million output tokens, and $2.50 per 1,000 search queries. Reasoning tokens count as output. Pricing and actual billed usage can change (verify). See [META_POLICY.md](META_POLICY.md) and [RESEARCH_POLICY.md](RESEARCH_POLICY.md).

## Architecture and safety

A deterministic single-writer reducer owns each project's versioned state, with a journal and snapshots stored in SQLite. Model roles propose; application code validates and decides. Research checks require actual searches; a claim counts as verified only when its own quote is found verbatim in retrieved source text (a page Sidethought fetched itself, or a search result snippet; in testing the snippets were empty), and other claims are shown as citation-only; the Checker reviews unprompted remarks against current state and evidence. Web content is treated as untrusted data, not instructions; a matching quote alone does not establish truth or entailment.

- Keys stay on the server; the app is protected by a passcode. Use a separate clean database for any demo; don't expose a personal workspace.
- The page fetcher restricts URLs and public IPs, pins validated DNS answers, rechecks redirects, and bounds time, size and content types to reduce SSRF risk. See [RESEARCH_POLICY.md](RESEARCH_POLICY.md).
- Search is designed to use a public abstraction, not private project text; the Investigator does not receive project history or reviewed lessons. Privacy filters are lexical, can miss paraphrases, and are not a guarantee against disclosure: don't enter secrets or sensitive information.
- Lessons are shared only after explicit review and confirmation; target-project recall is off by default and matches supplied terms lexically. Editing or forgetting a lesson can conservatively remove affected assistant replies and extracted target state; already-sent provider data cannot be recalled.
- On a version mismatch, journal replay attempts an upgrade without replaying effects and creates a backup before writing. Some projects fail closed, including those with changed or forgotten lesson uses. Backups may retain data later removed from the active database.

## Limitations

Live model quality, timing and initiative vary; the five-minute sequence is not a guaranteed outcome.
In live runs on 2026-11-03 (scenario scripts, Meta Spark), Sidethought started its own research every time
it woke; a verified research remark was spoken in 3 of 3 Supabase runs. After prompt tuning on 2026-11-04,
a research-backed idea was spoken in 4 of 5 Supabase runs and 0 of 2 Windows-on-ARM runs (inconclusive
research there). These are small samples, not a benchmark; the rest stayed cards because the final checks
are strict.

**Corrections usually, but not always, reach the stored plan.** Before the Nov 4 fix, two live tour tests
that changed Supabase Free to Pro failed: the stored option never changed and obsolete free-tier remarks
were delivered (a partial-clause quote rejection and a disallowed proposed-to-superseded transition).
The Interpreter now chooses the operation by the item's status (reject + create for a proposed item,
supersede for a stated one) and quotes whole clauses; its output cap was raised after live outputs hit it.
In seven later live tests (during research or after a finding) the correction was saved in five: three
marked an existing free-tier finding stale and two cancelled the free-tier research before it finished.
The misses were an output-cap failure (since raised; the next three runs all saved the correction) and a
first message whose free-tier plan was never stored, leaving nothing to correct. No obsolete free-tier
remark was delivered after a correction in any of these eight runs. These are small samples. Inspect
Project state and findings; a fluent reply is not confirmation that outdated advice has been withdrawn.

**Reviewed memory works in replies; live unsolicited lesson delivery remains unverified.** The Nov 1
live lesson test showed recall in a reply. A fresh two-project live API test on 2026-11-04 again recalled
a source-only fact (47 minutes) with the source project named. The audit recorded supply to both Responder
and Deliberator, but the Deliberator nominated nothing and no unprompted lesson remark arrived during
180 seconds after the target message. This proves attributed recall, not improved decisions or asynchronous
lesson delivery; the unsolicited lesson path has synthetic test coverage only.

The fetch-before-structuring research path passed two live script runs on 2026-11-02 (4 of 4 and 6 of 6
claims quoted from fetched pages, about $0.06 each); results inside the app vary by question and site.
Some sites block fetching, and JavaScript-rendered pages and PDFs are not extracted. Quote and consistency
checks are imperfect; not every source or claim will verify. In the correction tour, even a mixed finding's
conflicting sources did not prevent an uncaveated free-tier remark: quote verification is not factual
confirmation, and source caveats can be lost in delivery.

Voice input, general deletion and Hold/Mute are not built (read-aloud is output only and untested on iOS);
there are no temporary sessions. Run one server per database.

## Tests

```sh
npm run typecheck
npx vitest run --maxWorkers=2
npm run build
```

On 2026-11-04, after `npm ci --ignore-scripts`, typecheck, the full Vitest run (**135 test files / 1,486 tests**) and the production build passed. Automated tests do not establish live usefulness or safety in every case.

## Event work and license

All repository code was written from 2026-10-27 for the event; no prior code was reused. A similar idea was explored in an earlier hackathon, separately from this implementation. **MIT License**; see [LICENSE](LICENSE).
