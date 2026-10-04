# Build coding and source preservation

TOPIC: build.coding-source
PURPOSE: Frame a minimum complete coding task and preserve the user's work.
WHEN TO USE: Existing-repository import, repair, agent handoff, source review or Git restore questions.
REQUIRED FACTS: Exact project; instructions; current Git status/diff; intended outcome; named files/behavior to preserve; verification and recovery scope.

STABLE PRINCIPLES
Build prepares a portable reviewed task for the official coding client. It does not make Advisor a second coding agent. Read repository instructions and current source before editing. Inspect staged, unstaged and untracked work; one diff does not describe all local state. Source existence, a commit, and model completion each prove less than a working user journey.

The current Build path supports its React/TypeScript/Vite starter and supported existing React/Vite projects. Starter creation is not brief implementation. Trust is required before local project execution and resets after restart; executing Node/Vite scripts runs with the user's permissions, not an assumed OS sandbox. Review scripts/configuration before granting that trust.

DECISION TREE
Can the problem be diagnosed without mutation? Inspect it first. Is the desired repair bounded? Name the one change, preserve list and observable acceptance. Let the user's existing Build/Codex workflow perform the repair. Review changed paths and current checks afterward. Keep unrelated refactoring, dependency churn and cosmetic redesign outside the task.

For recovery, compare current status with the exact desired source and paths. Prefer a small correction or reviewed selected-path restore over destructive reset. Build's source restore is limited to worktree paths and can remove a path absent from the chosen source. It is not an automatic backup or universal rollback. HEAD/index, ignored files, databases, deployments, browser data and external side effects have separate ownership. SOURCE_RESTORE != EXTERNAL_EFFECT_ROLLBACK.

COMMON FAILURE MODES
Blanket reset/clean/stash advice, overwriting another task's edits, assuming a patch backs up a database, copying raw secret-bearing logs to a provider, weakening tests, or reusing a stale handoff without checking its source binding.

STOP CONDITIONS: Unknown ownership, conflicts, unreviewed destructive scope, partial recovery or uncertain external delivery. Reconcile actual effects before another attempt. Advisor may prepare the task but never runs Git, commits, pushes, merges or deploys on the user's behalf.
WHAT NOT TO CLAIM: Restored bytes already verified, all files preserved without inspection, or native account/billing eligibility from a handoff.
NEXT ACTION / OUTPUT SHAPE: Objective; current evidence; CHANGE/PRESERVE; required checks; stop conditions; expected diff/results.
SOURCE STATUS: Distribution guidance. Owner source paths are indexed in knowledge.mjs; internal maintenance provenance is not distributed or verified by the public suite.
LAST VERIFIED: 2026-10-04. RECHECK TRIGGER: Project instructions, source/flow, restore contract, Git/runtime or execution-scope changes.
