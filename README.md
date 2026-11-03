# Sidethought

Sidethought is a text-first thinking partner for solo builders that remembers named projects and can speak up on its own when something matters. It combines background reasoning, live web research with quote-verified sources, and explicitly reviewed lessons from other projects. Its dependency-aware checks are designed to suppress advice when its basis changes, rather than keep repeating an obsolete point.

## Built and planned

**Built:** text conversation; named projects; reviewed cross-project lessons; a background Deliberator that starts its own research and turns finished research into its own idea ("I checked: … so I'd …"); unprompted contributions gated by a final Checker; web research with independently fetched page quotes; finding cards; stale-advice suppression; old-project upgrade by journal replay; and optional read-aloud of new replies and unprompted remarks (browser speech synthesis).

**Planned:** voice input and spoken turn-taking, broad automatic memory, general project/session deletion (T08), and Hold/Mute controls. This is a prototype, not a production service.

## Quick start

Requirements: Node 24, npm, and a platform-compatible prebuilt `better-sqlite3` binary. From this repository:

```sh
npm ci --ignore-scripts
```

Copy `.env.example` to `.env` and configure the following **server-side** variables; do not share or commit `.env`:

- Required: `SIDETHOUGHT_PASSCODE`, `SIDETHOUGHT_COOKIE_SECRET` (at least 32 characters), `SIDETHOUGHT_ALLOWED_ORIGINS` (comma-separated exact origins).
- For Meta: `MODEL_API_KEY`, optionally `SIDETHOUGHT_MODEL`. Without a key, the default dev model is network-free and synthetic; it cannot demonstrate live research or real model quality. An explicit dev selection remains network-free even if a key is present.
- Optional: `PORT`, `SIDETHOUGHT_DB_PATH`, `META_API_BASE_URL`, `META_INPUT_USD_PER_MILLION`, `META_CACHED_INPUT_USD_PER_MILLION`, `META_OUTPUT_USD_PER_MILLION`, `NODE_ENV`. For **local HTTP on 127.0.0.1 only**, enable `SIDETHOUGHT_DEV_INSECURE_COOKIE`; never enable it for public or tailnet access. See `.env.example` for the variable names.

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
4. **Correct the plan.** Change a requirement while a dependent check is running, or correct an earlier point. Inspect the project state and finding: obsolete work should be dropped or marked stale rather than presented as current.
5. **Save a lesson in project A.** Select a source user message in **Reviewed cross-project lessons**, review its quote, write a lesson and applicability terms, and explicitly confirm sharing.
6. **Try project B.** Create a separate project, turn cross-project recall ON, and describe a matching situation without repeating the source fact. The Deliberator can raise the lesson unprompted with its source; it is experience to consider, not evidence or a decision. A foreground reply may mention it instead and is not proof of an asynchronous contribution. Check **Recently supplied** for provenance.
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

Live model quality, timing and initiative vary; the five-minute sequence is not a guaranteed outcome. In live runs on 2026-11-03 (scenario scripts, Meta Spark), Sidethought started its own research every time it woke; a verified research remark was spoken in 3 of 3 Supabase runs, and a research-backed idea was spoken in 1 of 3 runs. The rest stayed cards because the final checks are strict or a model reply hit its output limit. The Nov 1 live lesson test showed recall in a reply, not an independently delivered lesson contribution or an improved decision; the unsolicited lesson path was tested synthetically. The fetch-before-structuring research path passed two live script runs on 2026-11-02 (4 of 4 and 6 of 6 claims quoted from fetched pages, about $0.06 each); results inside the app vary by question and site. Some sites block fetching, and JavaScript-rendered pages and PDFs are not extracted. Quote and consistency checks are imperfect; not every source or claim will verify. Voice input, general deletion and Hold/Mute are not built (read-aloud is output only and untested on iOS); there are no temporary sessions. Run one server per database.

## Tests

```sh
npm run typecheck
npx vitest run --maxWorkers=2
npm run build
```

On 2026-11-03, after `npm ci --ignore-scripts`, typecheck, the full Vitest run (**131 test files / 1,429 tests**) and the production build passed. Automated tests do not establish live usefulness or safety in every case.

## Event work and license

All repository code was written from 2026-10-27 for the event; no prior code was reused. A similar idea was explored in an earlier hackathon, separately from this implementation. **MIT License**; see [LICENSE](LICENSE).
