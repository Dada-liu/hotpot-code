# Working in packages/hotpot-agent/

- This is the npm distribution package. Unlike every other workspace package it is unscoped: the published name is `hotpot-agent`, while the installed binary is `hotpot`. The npm name `hotpot` is already taken by an unrelated project.
- It owns process wiring only: command routing (`src/cli.ts`), `hotpot web` argument parsing and server startup (`src/web.ts`), and browser launching (`src/open-browser.ts`). Agent behavior stays in `@hotpot/core` / `@hotpot/orchestrator`.
- `@hotpot/cli` and `@hotpot/server` are devDependencies on purpose: tsup bundles workspace sources into the single `dist/bin.js`. Runtime dependencies (`@hono/node-server`, `@modelcontextprotocol/sdk`, `hono`, `zod`) stay external and must match the versions used by the workspace packages.
- `pnpm build` (from the package or the repo root) runs `tsup`, bundles `src/bin.ts`, then copies `../web/dist` to `dist/web`. The published package only ships `dist/` plus README and LICENSE; `files` is the whitelist.
- Static assets are resolved at runtime: packaged layout uses `<package>/dist/web`; source layout falls back to the repo's `packages/web/dist` and `public/`. `HOTPOT_WEB_DIST` / `HOTPOT_PUBLIC_DIR` override both.
- Keep `src/node-builtins.d.ts` a superset of both `packages/cli/src/node-builtins.d.ts` and `packages/server/src/node-builtins.d.ts`; importing both workspace packages pulls their sources into this package's tsc compilation. Do not add `@types/node`.
- `hotpot` with no arguments enters chat, `hotpot chat ...` is equivalent, and leading flags such as `hotpot --session <path>` are treated as chat flags. `hotpot web` starts the local server on `127.0.0.1` by default and prints/opens the token-bearing URL returned by `startServer`.
- Keep the package version in `package.json` and `APP_VERSION` in `packages/telemetry/src/defaults.ts` in sync; the release workflow rejects a tag that does not match the package version.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments and README in Simplified Chinese, AGENTS in English.
- Verify with `pnpm test`, `pnpm typecheck`, `pnpm exec biome check` and `pnpm build` from the repo root before releasing.
