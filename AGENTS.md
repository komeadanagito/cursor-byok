# AGENTS.md
- **The directory structure is the architecture.** Simple, clear directory and module naming >= module dependency relationships > concrete implementation details; communicate with the user using directory trees.
- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## Communication

- Lead with the conclusion. Keep responses direct and omit filler, repeated context, generic explanations, and narration of obvious steps.
- Match the level requested by the user: discuss architecture as architecture, behavior as behavior, and code details only when they materially support the answer.
- For architecture, refactoring, and module-boundary discussions, communicate primarily with annotated directory trees and ASCII architecture/data-flow diagrams instead of long prose.
- In directory trees, annotate every relevant directory and file with its single responsibility. When discussing code size, include line counts in the comments:
  - use measured line counts for existing code;
  - use clearly marked approximate targets such as `≈300 lines` for proposed code;
  - state whether tests, generated code, and blank lines are excluded.
- Show the complete main execution path, including inputs, ownership boundaries, runtime loops, persistence, outputs, and extension points. Make the direction of data and control flow explicit.
- Clearly separate the current structure from the proposed structure. Explicitly list modules that move, merge, split, or are deleted.
- Use the user's vocabulary consistently. Do not introduce new domain terms when existing plain-language terms are sufficient; when an implementation name must be mentioned, distinguish it from the architecture concept.
- For stateful or concurrent behavior, show timing, ownership, state boundaries, and before/during/after behavior explicitly. Distinguish continuation within the same lifecycle from creation of a new lifecycle.
- Prefer compact trees, flow diagrams, state matrices, and mappings when they communicate the structure more clearly than paragraphs.
- Tie recommendations to the actual repository structure and code. Do not present a speculative target architecture as if it already exists.

## Test-first development

Every behavior change starts as a failing test that states the behavior, then the smallest implementation that makes it pass.

- Write the assertion as the user-visible rule, not as an echo of the implementation. "projection of turn N+1 must keep turn N as an exact structural prefix" is a rule; "function returns Ok" is not.
- Keep the failing test in the same commit as the fix. A fix without its regression test is unfinished work.
- Name tests after the behavior, not the code: `settled_history_projects_as_a_stable_prefix`, `prunes_dead_lineages_and_keeps_the_live_one`, `failed_commit_reports_the_error`.
- Cover the boundaries, not the happy path: what happens when the invariant is violated, when a dependency is missing, when a transaction fails halfway.
- For concurrency and persistence, assert the recovery path too — the case where the process died mid-operation is the one that actually ships bugs.

Area rules live under [`.agents/skills/`](.agents/skills/) and override general guidance where they apply. Read the matching skill before touching its area:

| Area | Skill |
|---|---|
| Provider history, prompts, checkpoints, compaction | `cursor-prefix-stability` |
| Schema, migrations, store queries | `database-schema` |
| React/Tauri desktop frontend | `frontend` |
| Localization | `i18n` |
| Floating overlays | `floating-ui` |
| Model dropdowns | `model-selection` |
| Releases | `release` |

## Code style

- Each module opens with a one-line `//!` doc stating its single responsibility: `//! Prunes dead checkpoint lineages and reclaims SQLite space at startup.`
- Comments explain **why**, never what. A comment that restates the code is a comment to delete. The useful comments here explain invariants, failure modes, and the reason a choice is not the obvious one.
- Comments in `server/` are English. Match the surrounding file when adding to it.
- Error messages name the failing thing and the constraint that failed: `"message id or runtime event reused with different content: {id}"`, not `"internal error"`.
- Prefer a shared helper over a copy of the logic — but only after the second copy exists. The first copy is not yet a pattern.
- Keep layers where they are. A change that moves behavior across a module boundary is an architecture change and needs the directory-tree analysis described above.
- No compatibility shims. If a stored shape is wrong, migrate the data once and make the application read only the new shape.
- Frontend copy goes through `t()` with the Chinese source string inline; the scan fills `zh-CN`, and `en-US` / `pt-BR` are filled by hand in the same commit.

## Verification gate

A change is not done until the repository checks pass. These are exactly what CI runs:

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --all-targets
npm --prefix apps/desktop run check
```

For changes under `server/plugins/`, also run the plugin's own tests:

```bash
cd server/plugins/build-in/<plugin> && deno test --allow-all
```

Storage work additionally needs a measurement on a real database copy, before and after — row counts and file size, not just green tests.

Do not repair unrelated failures in the working tree while validating. Report them separately from failures the change caused.
