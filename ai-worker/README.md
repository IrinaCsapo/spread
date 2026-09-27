# Spread AI Worker

A Cloudflare Worker that holds your Anthropic API key and asks Claude to arrange a book. The editor's **Arrange with AI** button calls it. Free on Cloudflare; you pay Anthropic per use (roughly 20 to 40p for a 30-image book).

## One-time setup

You need an Anthropic API account (console.anthropic.com, with billing and a monthly spend limit set) and a free Cloudflare account.

Run these in this folder (`ai-worker/`):

```bash
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put SPREAD_PASSPHRASE
npx wrangler deploy
```

- `wrangler login` opens your browser to connect Cloudflare.
- Each `secret put` asks you to paste a value. Use a long passphrase you don't use anywhere else.
- `deploy` prints the Worker's address, like `https://spread-ai.<you>.workers.dev`.

Then in the editor, click **AI settings** and paste that address and your passphrase.

## Changing things

- Prompt, schema and model: `src/index.js`. Deploy again with `npx wrangler deploy`.
- Which sites may call it: `ALLOWED_ORIGINS` in `wrangler.toml` (local previews on localhost are always allowed).
- New passphrase: `npx wrangler secret put SPREAD_PASSPHRASE`, then update AI settings in the editor.

## Test locally

Create `.dev.vars` (git-ignored) with `ANTHROPIC_API_KEY=...` and `SPREAD_PASSPHRASE=...`, run `npm run dev`, and point AI settings at `http://127.0.0.1:8787`.
