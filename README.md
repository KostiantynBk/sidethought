# Sidethought

Sidethought is a text-first, voice-later thinking partner for solo builders. All code in this repository is written
for the Meta Global AI Developer Hackathon build window, starting 2026-10-27.

## Local development

Use Node 24 or newer. Run `npm ci` and then `npm run typecheck` and `npm test`. Installation scripts are disabled
by the repository's `.npmrc`; the installed platform-specific prebuilt SQLite binary must load on your system.

Copy `.env.example` to `.env` and provide `SIDETHOUGHT_PASSCODE`, a `SIDETHOUGHT_COOKIE_SECRET` of at least
32 characters, and comma-separated `SIDETHOUGHT_ALLOWED_ORIGINS`. Do not share or commit this file. Configure
`SIDETHOUGHT_DB_PATH` and `PORT` if the defaults are unsuitable. The model defaults to `dev` without a model key;
set `SIDETHOUGHT_MODEL=meta` and `MODEL_API_KEY` to use Meta Spark. A key also selects Meta when the model
selector is unset. Explicit `dev` remains network-free even with a key present. Meta without a key fails startup.
Keys stay in server-only configuration and are never sent to the browser. `/health` reports the selected model.
The current UI's fixed dev badge is not yet wired to that endpoint; do not use that badge to identify the backend.
See [Meta policy and smoke-run notes](META_POLICY.md) for caps, pricing, transport assumptions and manual verification.

Run `npm run dev` for the gateway and Vite. Add the exact Vite origin to the allowed origins. For local HTTP on
`127.0.0.1` **only**, set `SIDETHOUGHT_DEV_INSECURE_COOKIE` to `1`; it is off by default. Never use this option
for tailnet or public access. For the built app run `npm run build` and `npm start`.

## iPhone over Tailscale

Build and start the app, then run `tailscale serve --bg <port>` on the host. Tailscale Serve provides HTTPS to
other tailnet devices. Enable HTTPS certificates in the tailnet if needed, run Tailscale on the iPhone, and use
Safari. Add the exact HTTPS origin to `SIDETHOUGHT_ALLOWED_ORIGINS` and keep the insecure-cookie option off.
Run `tailscale serve reset` to disable the proxy. Judge access is a separate, undecided deployment step.

## Current limitations

The dev model produces synthetic replies and does no network calls. The Meta model implements Interpreter and
Responder only; research jobs, Deliberator and Checker are unsupported in this cut. Meta integration is tested
with fake HTTP streams only until a separately authorized live smoke run is performed.
Until the delivery-progress integration lands, reconnecting after a reply can show a dimmed
“may not have been shown” card instead of confirmed transcript text.
