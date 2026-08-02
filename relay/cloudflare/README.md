# Anchor Code Cloudflare Relay

This deployment unit contains no Electron or Mobile UI code. It enforces a
five-minute one-use pairing ticket, waits for PC approval, issues independently
revocable device credentials, tracks presence, and forwards opaque AES-GCM frames.
Source code, prompts, terminal output, and the end-to-end secret are never sent
to Worker storage.

## Deploy

```bash
npm install
npx wrangler login
npm run typecheck
npm run deploy
```

Wrangler prints the `https://<worker>.<subdomain>.workers.dev` address. Enter
that address in **Anchor Code -> Settings -> Mobile access -> Relay URL**.

The current production deployment is
`https://anchor-code-relay.anchor-code-mobile.workers.dev`. Anchor Code ships
with this address prefilled; users only need to enable the relay and click
Apply. The field remains editable for self-hosted or staging deployments.

The default configuration creates a SQLite-backed Durable Object and works on
the Workers Free plan. Use separate Worker names and Durable Object namespaces
for development, staging, and production before serving external users.
