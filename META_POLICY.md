# Meta Spark executor — T09 policy inventory

This is a text-only Interpreter/Responder adapter. Strict-schema live smoke passed Oct 31; bounded guidance
and reviewed cross-project lesson recall were checked Nov 1. This is not general live coverage of every error path.
The server uses the exact-pinned `openai` 7.45.1 SDK (Apache-2.0). Its automatic retries and logging are disabled.
The SDK builds/sends the request; a small local SSE decoder preserves error envelopes and their usage, which
its high-level stream iterator otherwise turns into exceptions.

## Existing model-cap policies used by this adapter

Values come from `State.config` (`src/config/index.ts`), not duplicate executor constants:

| Policy | Default | Meaning |
|---|---:|---|
| `interpreterMaxOutputTokens` | 1200 | Initial Interpreter cap, including reasoning and visible JSON |
| `structuredRetryTokenMultiplier` | 1.5 | Interpreter attempt >= 2 gets `ceil(normal cap × multiplier)` |
| Effective default Interpreter retry cap | 1800 | Only a fresh kernel-issued call can use this cap |
| `responderMaxOutputTokens` | 800 | Responder cap, including reasoning and visible text |

These include reasoning, not 1200/800 visible tokens plus reasoning. In the Nov 1 guidance run, low effort
used 673/800 output tokens for reasoning and truncated a simple explanation. Responder now uses minimal
(reasoning 173/330 and 57/251 in two complete examples). The real UI then exposed Interpreter failures at
both 1200/1800 caps with low effort. Interpreter also now uses minimal: three actual-prompt/kernel samples
completed at 536, 1072 and 899 total output tokens with quote-backed item application. No cap was raised.
No adapter repair call or retry exists.
The existing config bounds remain unchanged: Interpreter normal cap <= 4800, Responder <= 3200, multiplier <= 4.

## Server-only configuration

- Model: `muse-spark-1.3`, Standard mode only.
- `META_API_BASE_URL`: defaults to `https://api.meta.ai/v1`; HTTPS URL without embedded credentials/query/fragment.
- `MODEL_API_KEY`: read only in `src/model/meta/config.ts`, captured privately and passed into the SDK constructor.
- `SIDETHOUGHT_MODEL`: `dev` by default without a key, `meta` by default with a key; an explicit choice wins.
- Meta requires a nonblank key. No connection or API call is made merely to construct the runtime.
- `META_INPUT_USD_PER_MILLION`: 1.25 default.
- `META_CACHED_INPUT_USD_PER_MILLION`: 0.15 default.
- `META_OUTPUT_USD_PER_MILLION`: 4.25 default.
- Pricing overrides must be finite, positive and <= 100. Empty values use defaults.
- Cost subtracts cached tokens from regular input; reasoning is already included in total output tokens.
- Invalid/missing usage is not fabricated. Missing cached/reasoning detail counts default to zero; validate these
  optional provider details in the live run. The `llm.usage` event cannot carry their separate counts, so local
  metrics retain them. Aborted calls emit no further events; billed post-abort work cannot be measured here.

## Request and outcome behavior

All calls use `stream: true`, `store: false`, explicit instructions/input and an output cap.
Interpreter and Responder reasoning effort are `minimal` after the Nov 1 measured real-prompt fixes.
No history ID, tools, encrypted reasoning replay, `response_format`, provider fallback or extra repair request.
Only the Interpreter uses `text.format` with `type: json_schema` and `strict: true`.

The schema is generated with zod 4 from `InterpreterOutputSchema`, then adapted only on the wire:

- Disjoint discriminated `oneOf` branches become nested `anyOf` branches.
- Optional fields become required nullable fields, as Meta's strict subset requires all properties to be required.
- The decoder restores null to absence only at the original schema's optional positions, then performs unchanged
  zod validation. Required nulls, unknown null fields, quote-bound refinements and per-input request limits are
  still rejected. No kernel schema or role prompt changes.
- References are inlined, recursive schemas throw, and tests enforce strict objects and nesting <= 10.
  Nesting measures object/array schema structure, not JSON keyword-wrapper depth.

Only `response.completed`, `response.incomplete`, `response.failed`, and `error` are terminal outcomes.
`[DONE]` or EOF without a terminal event fails. HTTP 200 alone is not success.

T09 decision 2 / architecture §12:

- Responder `incomplete_details.reason=max_output_tokens`: emit `reply.done`, meter `cap_reached`. The kernel
  checks and flushes the final tail. This never bypasses output checks.
- Interpreter cap: emit `interpretation.failed` with `output_cap`; the kernel may authorize its single retry.
- Other incomplete reasons fail. No adapter-level retry occurs.

Usage is emitted before the outcome, so a synchronous kernel abort/retry cannot lose the terminal's known cost.
IDs are deterministic per call (`chunk:0`, `chunk:1`, `usage`, `ready`, `done`, `failed`). Repeated effects for the
same call are suppressed locally; replay through a fresh executor produces the same IDs for runner deduplication.
Abort cancels the HTTP request and stream reader. No later event for the call is emitted. This is local/best-effort
cancellation, not a claim that Meta stops generating or billing server-side.

Local per-call metrics carry IDs, role, start/first-delta/terminal timing, output character count, terminal type,
outcome, schema-pass flag and token/cost counts only. Provider exceptions, prompt text, output text and keys are
never logged or forwarded as failures. The optional metrics callback receives only this whitelist.

## Manual smoke run — not run by T09 builder

After separately authorizing live calls and setting server environment values:

```sh
npx tsx --env-file=.env scripts/spark-smoke.ts
```

It performs one synthetic Interpreter and one synthetic Responder call, each locally aborted after 25 seconds.
It exits with a clear configuration message if the key is missing. It prints no prompts or outputs: only timing,
token counts (including cached/reasoning), cost, terminal/outcome and Interpreter schema-pass status.
It is statically typechecked but never imported by the test suite.

## Original T09 verification checklist (partially verified Oct 31 / Nov 1)

Documentation read: https://dev.meta.ai/docs/protocols/responses and https://dev.meta.ai/docs/structured-output.

- Actual participant-account acceptance of the generated strict schema, including optional-null unions, numeric
  constraints, JSON Schema metadata and depth interpretation.
- Actual `response.output_text.delta` text field, lifecycle ordering, `response` envelope, error event shape,
  `incomplete_details.reason=max_output_tokens`, and terminal usage detail fields.
- Whether account responses omit optional cached/reasoning details; actual latency and useful cap sizes.
- Server-side billing/generation behavior following a locally aborted `store:false` request.

The real root is exercised with fake fetch, authenticated in-memory websocket injection, in-memory SQLite and
manual time. It verifies context assembly, quote-backed state changes, checked sentence release and completion.
T13 wired the browser header to authenticated model metadata. `/health` and server startup reporting also
identify the model. Reusable lesson context is selected only for opted-in Responder calls; it is never a tool
request or web query. Other projects' raw histories and Interpreter quote witnesses remain isolated.
