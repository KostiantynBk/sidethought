# Sidethought

Sidethought is a text-first, voice-later thinking partner for solo builders. All code in this repository is written
for the Meta Global AI Developer Hackathon build window, starting 2026-10-27.

## Local development

Use Node 24 or newer. Run `npm ci` and then `npm run typecheck` and `npm test`. Installation scripts are disabled
by the repository's `.npmrc`; the installed platform-specific prebuilt SQLite binary must load on your system.

Copy `.env.example` to `.env` and provide `SIDETHOUGHT_PASSCODE`, a `SIDETHOUGHT_COOKIE_SECRET` of at least
32 characters, and comma-separated `SIDETHOUGHT_ALLOWED_ORIGINS`. Do not share or commit this file. Configure
`SIDETHOUGHT_DB_PATH` and `PORT` if the defaults are unsuitable. The model defaults to `dev` without a model key;
T10 supports only the clearly labelled network-free dev model and refuses to start with a real model selected.
`MODEL_API_KEY` is reserved for the later real executor and is never sent to the browser.

Run `npm run dev` for the gateway and Vite. Add the exact Vite origin to the allowed origins. For local HTTP on
`127.0.0.1` **only**, set `SIDETHOUGHT_DEV_INSECURE_COOKIE` to `1`; it is off by default. Never use this option
for tailnet or public access. For the built app run `npm run build` and `npm start`.

## iPhone over Tailscale

Build and start the app, then run `tailscale serve --bg <port>` on the host. Tailscale Serve provides HTTPS to
other tailnet devices. Enable HTTPS certificates in the tailnet if needed, run Tailscale on the iPhone, and use
Safari. Add the exact HTTPS origin to `SIDETHOUGHT_ALLOWED_ORIGINS` and keep the insecure-cookie option off.
Run `tailscale serve reset` to disable the proxy. Judge access is a separate, undecided deployment step.

## Current limitations

The dev model produces synthetic replies and does no network calls. Research jobs are unsupported in this cut.
Until the delivery-progress integration lands, reconnecting after a reply can show a dimmed
“may not have been shown” card instead of confirmed transcript text.
