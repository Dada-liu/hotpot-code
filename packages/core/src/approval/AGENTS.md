# Working in src/approval/

- `ApprovalChain.ask` is fail-closed: if every handler returns "next" (or none are registered), the decision is "deny". This is a safety-critical path — keep test coverage for both empty-chain and all-next cases.
- Handlers run sequentially in registration order; the first "allow"/"deny" short-circuits. Do not add parallelism.
- `allowAllHandler` approves any request and is reserved as the chain head for `full` permission mode (never interrupts the user); handlers registered after it never run. It is defined in `chain.ts` and re-exported through `index.ts`.
- `chain.ts` stays pure (no session awareness). Emitting `approval/asked` / `approval/decided` events is done by the audit wrapper in `audit.ts` (`createAuditedApprovalChain`), which delegates to an inner chain; orchestrator-level flows may also append `approval/decided` themselves (with `note`).
- Export the feature's public surface through `index.ts`; cross-feature imports target concrete files.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test` and `pnpm exec biome check` from the repo root before committing.
