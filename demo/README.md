# Intro demo video

Engine vendored from the product-demo-video skill. `demo.config.json` drives the real app on sample data
(`scripts/seed-demo-intro.ts`); `serve.mjs` starts `next dev`, warms routes (`warmup.mjs` replays the config actions),
re-seeds, and signs the throwaway demo user in. Recording runs on `dev-builder` over ssh.

Remote prerequisites: a throwaway database (e.g. `compass_demo` on dev-postgres) and `~/.compass-demo.env` (mode 600) with
`DATABASE_URL=...?schema=compass_dev`, `AUTH_SECRET`, `AUTH_URL=http://localhost:3000`, `AUTH_TRUST_HOST=true`.
Never point these at preview, production or Aurora DSQL. Run: `ELEVENLABS_VOICE_ID=... node demo/engine/run.mts all`.
