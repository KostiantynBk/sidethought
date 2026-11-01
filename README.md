# Sidethought

Sidethought is a text-first, voice-later thinking partner for solo builders. All code in this repository is written
for the Meta Global AI Developer Hackathon build window, starting 2026-10-27.

## Local development

Use Node 24 or newer. Run `npm ci --ignore-scripts`, then `npm run typecheck` and
`npx vitest run --maxWorkers=2` serially. Installation scripts are disabled
by the repository's `.npmrc`; the installed platform-specific prebuilt SQLite binary must load on your system.

Copy `.env.example` to `.env` and provide `SIDETHOUGHT_PASSCODE`, a `SIDETHOUGHT_COOKIE_SECRET` of at least
32 characters, and comma-separated `SIDETHOUGHT_ALLOWED_ORIGINS`. Do not share or commit this file. Configure
`SIDETHOUGHT_DB_PATH` and `PORT` if the defaults are unsuitable. The model defaults to `dev` without a model key;
set `SIDETHOUGHT_MODEL=meta` and `MODEL_API_KEY` to use Meta Spark. A key also selects Meta when the model
selector is unset. Explicit `dev` remains network-free even with a key present. Meta without a key fails startup.
Keys stay in server-only configuration and are never sent to the browser. `/health` reports the selected model.
The UI model badge comes from the authenticated project API; `/health` remains a direct backend check.
See [Meta policy and smoke-run notes](META_POLICY.md) for caps, pricing, transport assumptions and manual verification.

Run `npm run dev` for the gateway and Vite. Add the exact Vite origin to the allowed origins. For local HTTP on
`127.0.0.1` **only**, set `SIDETHOUGHT_DEV_INSECURE_COOKIE` to `1`; it is off by default. Never use this option
for tailnet or public access. For the built app run `npm run build` and `npm start`.

## iPhone over Tailscale

Build and start the app, then run `tailscale serve --bg <port>` on the host. Tailscale Serve provides HTTPS to
other tailnet devices. Enable HTTPS certificates in the tailnet if needed, run Tailscale on the iPhone, and use
Safari. Add the exact HTTPS origin to `SIDETHOUGHT_ALLOWED_ORIGINS` and keep the insecure-cookie option off.
Run `tailscale serve reset` to disable the proxy. Judge access is a separate, undecided deployment step.

## Named projects and reviewed cross-project lessons

The existing conversation remains **Current project**. Use **Create project** for a clean, independently stored
conversation; switch back to continue earlier work. New tables are additive to the existing SQLite database.
Do not delete the database to start over: it now holds all projects and lessons.

1. In project A, send a message containing a genuine lesson or relevant experience.
2. Open **reviewed cross-project memory**, choose the source user message, review its exact quote, and write
   the lesson you confirm. Enter 1–8 comma-separated applicability words or phrases.
3. Click **Confirm and share this lesson**. Nothing is learned or shared automatically.
4. Create project B and enable **Use relevant shared lessons for new replies** (off by default).
5. Discuss a relevant situation without repeating A's specific lesson. The Responder receives at most three
   matching lessons, with source project, message, quote, and version. Its suggestions are not B's decisions.
6. Inspect **Recently supplied** records to verify what context was sent. This is not proof it was useful.

Lessons are manually reviewed snapshots, not an automatically updated profile. Later source-project
messages do not silently rewrite a saved lesson: correct or forget that lesson explicitly in this panel.

Project interpretation status is shown separately from chat. If a message failed to reach project state,
click its **Retry interpretation** button explicitly; this makes another Meta call, not a new user message.
Old failures are not automatically retried on restart, and creating a new project does not clear old failures.

Matching is deliberately lexical, not semantic recall or model training. Whole histories and project items
are not shared. Foreign lessons never enter the Interpreter's quote witness. If using Meta, selected lessons
are sent to Meta for the foreground reply, not web search. Disabling retrieval affects new calls; earlier
conversation can still contain memory-derived content.

**Editing or forgetting:** confirm the displayed warning. To prevent indirect stale reuse, the prototype
removes assistant replies from first use onward and clears extracted state in affected target projects.
Original user messages and the source project remain. The source quote is immutable historical provenance;
the edited lesson is current. Active calls are aborted; late responses cannot restore old content.
If recovery fails the project is paused until server restart. Pending SQLite WAL cleanup is reported explicitly.
No local backups are made. Previously sent provider data cannot be recalled by a local deletion.

**Privacy/access limitations:** this is one passcode-authenticated owner's workspace, not separate user accounts.
All projects and explicitly shared lessons are visible to that owner. Normal conversations persist; temporary
sessions and project/session deletion are not implemented in this slice. Do not run multiple server instances
against one database. Judges must get a separate clean demo database with synthetic data, not personal projects.

## Manual live checks

These scripts make paid, bounded synthetic calls only when explicitly run. They do not open your conversation
DB or print keys. The guidance/memory scripts print synthetic replies for manual quality assessment.

```sh
npx tsx --env-file=.env scripts/guidance-smoke.ts
npx tsx --env-file=.env scripts/interpreter-smoke.ts
npx tsx --env-file=.env scripts/memory-smoke.ts
```

Guidance checks actual explanations/code. Interpreter smoke uses the real prompt and kernel quote/item checks,
not a trivial substitute instruction. Memory smoke compares off/on plus an unrelated control.
An ordinary suggestion inside a reply is **not** proof of asynchronous unsolicited contribution.

## Current limitations

The dev model produces synthetic replies and does no network calls; it does not demonstrate intelligent memory
use. Meta implements Interpreter and Responder only; research jobs, Deliberator and Checker remain unsupported
in this checkout. Real strict-schema smoke passed Oct 31; bounded guidance and reviewed-lesson recall were
checked live Nov 1. These few examples are not a broad quality benchmark or proof of improved decisions.
Voice and background unsolicited contributions remain unfinished. Missing delivery acknowledgment can produce
an honest “may not have been shown” card on reconnect rather than confirmed transcript text.
