# Build verification and diagnosis

TOPIC: build.verification-debug
PURPOSE: Find the first evidenced failure and the smallest useful repair/check.
WHEN TO USE: Verification failure, stale acceptance, missing critical flow, interrupted checks or an agent saying it finished.
REQUIRED FACTS: Project/revision; current owner status; first failed command or user step; bounded diagnostic; test scope; source changes since the run.

STABLE PRINCIPLES
MODEL_FINISHED != BUILD_VERIFIED. A test file existing does not prove meaningful assertions or a current run. Build owns verification. Its current flow is typecheck, build, test, then an optional named browser flow; later steps can remain NOT_RUN_IN_THIS_RUN after a failure. Read the first failure before rerunning. A source or critical-flow change invalidates prior acceptance when the owner's identity rules say so.

CURRENT_CHECKS_PASS_NO_FLOW is not CURRENT_PASS with a configured critical flow. Even CURRENT_PASS only proves the configured checks and assertions at that identity. Missing, interrupted or stale evidence cannot become a pass through explanation. Source hashes do not attest browser storage, remote services, deployed bytes or the installed environment.

DECISION TREE
Read current state. If UNKNOWN, obtain the owning receipt. If STALE, inspect the relevant source/flow change and rerun after review. If failed, find the first concrete error and distinguish installation/configuration, source, test or runtime behavior. Reproduce one defect, prepare the smallest Build repair, then verify the actual user outcome and required checks. After a reviewed restore, fresh verification remains required even if old bytes once passed.

Check persistence and recovery when promised: create/change a record, reload, observe the same data; try invalid input and a failed save. A same-origin browser reload does not establish cross-device storage. Prefer user-visible assertions and stable roles/labels over timing sleeps or implementation details. Inspect what a test actually asserts.

COMMON FAILURE MODES
Calling package installation safe execution; treating the workbench's tests as tests of the user's application; inferring mobile/all-browser coverage from one default Chromium flow; hiding skipped checks; repairing the test instead of the broken behavior.

STOP CONDITIONS: Unknown cause after repeated attempts, unsafe scripts, source ownership conflict or a repair outside scope. Preserve source and diagnostics; do not reset Git or weaken acceptance.
WHAT NOT TO CLAIM: Production readiness, environment equivalence, complete coverage or source loss solely from a failed check.
NEXT ACTION / OUTPUT SHAPE: Exact failed stage; evidence versus hypothesis; valid remainder; one diagnostic/repair; current verification required.
SOURCE STATUS: Distribution guidance. Owner source paths are indexed in knowledge.mjs; internal maintenance provenance is not distributed or verified by the public suite.
LAST VERIFIED: 2026-10-04. RECHECK TRIGGER: Source identity, scripts, flow definition, runner or environment changes.
