Audit the recent changes in this codebase. Follow this workflow:

## 1. Gather context

Run `git diff HEAD~1 --stat` (or `HEAD~N` if multiple commits were made for the current change) to understand what files changed. Read new and modified files to understand the full scope.

## 2. Spawn an audit agent

Use the Task tool with `subagent_type: "general-purpose"` and a prompt that includes:

- **Context**: What changed and why (infer from git log and diffs)
- **File lists**: Explicit lists of new and modified files for the agent to read
- **Check categories**:
  - Logic bugs, edge cases, race conditions
  - Tests that would pass even if the feature was broken (trivially passing assertions)
  - Missing assertions or insufficient test coverage
  - Inconsistent types across files
  - All new exports registered in `src/index.ts`
  - Internal operations (bulk, cascade, traversal) not accidentally constrained by safety checks meant for user-facing queries
  - Any backwards-incompatible changes that aren't intentional
- **Output format**: Ask for findings in CRITICAL / IMPORTANT / MINOR / POSITIVE categories with file paths and line numbers

## 3. Fix and iterate

When the audit returns findings:

- Fix all **CRITICAL** and **IMPORTANT** issues immediately
- Fix **MINOR** issues that are low-effort (test gaps, missing assertions, easy edge cases)
- Skip purely cosmetic MINOR items unless they affect correctness
- After fixing, run `pnpm typecheck && pnpm test:unit` to verify
- Re-run the audit agent (resume the same agent if possible) with the list of what was fixed so it can verify the fixes and check for new issues
- Continue until the audit returns no CRITICAL or IMPORTANT findings

## 4. Report

Summarize what the audit found, what was fixed, and any MINOR items intentionally deferred.
