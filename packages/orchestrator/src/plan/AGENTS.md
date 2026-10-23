# Working in src/plan/

- Reuse the plan produced in the initial turn whenever it exists (validated by `detectPlanDraft`: `# Plan` heading plus the Steps/Files/Acceptance criteria sections; the newest marked message in the turn window wins — a plan followed by a same-turn tool call and an extra note must still be detected). Only draft when the plan is missing or the next-step queue is non-empty at plan start; an annotation always takes a revision draft turn. Draft rounds themselves read the last non-empty assistant text (no marker re-validation): a malformed revision is caught by the approver, not silently dropped.
- The plan phase registers no tools — it builds an empty registry directly instead of calling `createRoleRegistry("main")`, because main's standard `read` tool (M1) must stay unavailable while planning. Internal continuation prompts are persisted as `internal_msg` (they enter model history but the UI must not render them).
- `plan(drafted)` must carry `messageIds` identifying the assistant message persisted as the plan, so the web can hide the duplicate text bubble.
- Approval decisions must be audited as `approval/asked` + `approval/decided`, with annotations/rejection notes stored in the denied decision.
- `planMaxRevisions` defaults to 3. On exceeding it, yield `revision_exhausted` and end without another asked/decided pair.
- Missing `onPlanApproval` is fail-closed (deny). Do not add an implicit approve path.
- `approve` must append the execution kickoff and flip `planApproved`/phase before returning.
- Export the feature's public surface through `index.ts`; cross-feature imports target this file directly.
- Erasable TypeScript only, `.ts` extension on relative imports, no `any`, no inline imports; comments in Simplified Chinese.
