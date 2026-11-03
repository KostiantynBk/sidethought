# Meta model policy

Sidethought uses Meta's Responses API through the server-side, pinned `openai` SDK. Model roles propose;
the kernel validates results and controls research admission and delivery. See [RESEARCH_POLICY.md](RESEARCH_POLICY.md)
for evidence and contribution gates. This is a prototype; live model behavior and latency vary.

## Roles and default limits

All roles use `muse-spark-1.3`. Output caps include reasoning tokens, not just visible text or JSON.
Defaults and configurable bounds are in `src/config/index.ts`.

| Role | Purpose | Reasoning effort | Default output cap |
|---|---|---|---:|
| Interpreter | Extract project changes and requests | minimal | 1,200; 1,800 on a fresh retry by default |
| Responder | Stream a conversational reply | minimal | 800 |
| Deliberator | Nominate insights, questions and investigations | medium | 6,000 |
| Checker | Review an unprompted contribution | minimal | 3,000 |
| Investigator search | Search the web in background mode | medium | 4,000 |
| Investigator structure | Structure search and fetched-page data | minimal | 3,000 |

Interpreter, Deliberator, Checker and Investigator structuring use strict JSON schemas; Responder streams text.
The Interpreter retry cap is the normal cap multiplied by the configured structured retry multiplier (default 1.5).
A retry is a fresh kernel-issued call, not an SDK or adapter repair request.

Default role deadlines are 15 seconds for Interpreter and Checker, 60 seconds for Deliberator, 20 seconds for a
reply, and 90 seconds for a research job. Reply first-token and stream-stall defaults are 8 and 5 seconds.
These are local controls, not provider latency or billing guarantees.

## Requests, usage and cancellation

The regular role calls stream with `store: false`; Investigator structuring does likewise. Investigator search
uses background `web_search`, requests result details and polls the response; it is not the same request path.
The SDK's automatic retries and logging are disabled. A local SSE decoder handles streaming terminal events;
HTTP success or an end-of-stream marker alone does not establish a completed response.

A Responder output-cap incomplete result may release the checked final tail; an Interpreter output cap fails the
attempt and the kernel may authorize a retry. Other incomplete outcomes fail. Cancellation is best effort:
local aborts and background cancellation do not establish that provider generation or billing stopped.
Missing or invalid usage is not fabricated; work billed after abort may be unmeasured.

Server configuration selects `dev` by default without a key and `meta` by default with one; an explicit selection
wins. The Meta key remains server-side. The default API endpoint is `https://api.meta.ai/v1`; configuration requires
HTTPS without embedded credentials, query or fragment. See `src/model/meta/config.ts` and the README for setup.

## Cost estimates

Configured defaults are $1.25 per million input tokens, $0.15 per million cached input tokens and $4.25 per
million output tokens. The server supports bounded positive overrides for these token prices. Cached input is
subtracted from regular input, and reasoning is already included in output. Search accounting uses $2.50 per
1,000 queries; actual queries are counted when available and unreadable query details are estimated.
These are local estimates, not a guarantee of current provider prices or final billing. Verify current pricing.

The default per-project research soft cap is $3, the hard cap is $5 and the development daily cap is $10.
Reservations and incomplete usage can make local admission conservative; they are not provider-enforced caps.
Multiple projects can incur additional spend. See `src/kernel/research/budget.ts` and the README.

## Limitations

Structured output and checks can fail or time out; a safe, useful unsolicited contribution is not guaranteed.
Reviewed lessons are opt-in context, not web evidence. Search privacy filtering is lexical and can miss
paraphrases. Do not enter secrets or sensitive information. Further limitations are in the README.

For the protocol and structured-output documentation, see
[Meta Responses](https://dev.meta.ai/docs/protocols/responses) and
[Meta structured output](https://dev.meta.ai/docs/structured-output).
