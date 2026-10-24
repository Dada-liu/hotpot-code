# Working in src/workspace/

- The workspace registry is a standalone persisted entity, not something derived from session cwd. Removing a workspace only unregisters the record: the directory and session logs stay on disk, and sessions fall back to the "ungrouped" bucket.
- Storage is `<home>/workspaces.json` with shape `{ version: 1, workspaces: WorkspaceRecord[] }`. Resolve `home` through `resolveHome` from `../session/store.ts` (explicit home > `HOTPOT_HOME` > `~/.hotpot`); never duplicate the rule.
- A missing storage file means an empty registry. Malformed JSON, an invalid shape, any version other than exactly `1`, or duplicate workspace ids must throw `WorkspaceError("invalid-storage")`. Never silently reset or rewrite corrupt storage: that destroys user data.
- Persist atomically: write `<file>.tmp`, then `rename` it over the target. Readers must never observe a partially written JSON file.
- `WorkspaceRecord.path` is the canonical `realpath`. `create` must validate: the original input is absolute (check it before/independent of `path.resolve`, which turns relative paths absolute), the path exists, and it is a directory. Failures throw `invalid-path` with the offending path in the message.
- Dedupe by canonical path: creating an already registered path returns `{ workspace, created: false }` and must not add a duplicate or change ordering.
- The array order is the display order, and `create` inserts at the front (newest first). `reorder` accepts only an exact permutation of the current ids (same length, every id once, no unknown ids); anything else is `invalid-order`.
- A session belongs to at most one workspace. `attachSession` removes the session from every other workspace first, appends it to the target, and updates the target's `updatedAt` only when membership actually changes. Re-attaching to the same workspace keeps its position and leaves `updatedAt` untouched. `detachSession` removes it everywhere and only writes when something changed.
- `remove` and unknown-id lookups throw `not-found`. `findByPath` is synchronous (`realpathSync`) and returns `null` instead of throwing for nonexistent or inaccessible paths. `workspaceForSession` returns `null` when unowned.
- `updatedAt` changes on rename and on membership changes; `createdAt` never changes.
- Export the public surface through `index.ts`; cross-feature imports target concrete files (for example `../session/store.ts`), never another feature's barrel.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
- Verify with `pnpm test`, `pnpm typecheck` and `pnpm exec biome check` from the repo root before committing.
