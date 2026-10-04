# Build performance and security fundamentals

TOPIC: build.performance-security
PURPOSE: Diagnose a measured performance symptom or identify a concrete trust boundary.
WHEN TO USE: Slow loading/interaction, layout shifts, exposed secrets, input/auth/session concerns.
REQUIRED FACTS: Actual stack and route; device/build/network conditions; trace or symptom; relevant data, caller, object and server boundary.

STABLE PRINCIPLES
Measure before optimizing. LCP concerns visible loading, INP responsiveness and CLS unexpected layout movement. Lab measurements explain a controlled run; field measurements describe real users under their report scope. A local Lighthouse score is not a field pass. Compare like conditions before and after one targeted change rather than rewriting the framework.

DECISION TREE
For slowness, locate the actual delay or shift. Check the important image's discovery/size, unnecessary main-thread work, font loading and reserved media dimensions. Defer nonessential assets where justified; do not lazy-load critical visible content or preload everything. Compare a served production build when diagnosing release behavior. Hosting/cache changes belong to the real host, not a fictional Build control.

For security, state the trust boundary first. Keep secrets out of client code, source control, URLs and prompts. Vite client-exposed environment values are not a vault. Validate payload shape, size and relationships at the trusted boundary. Authentication identifies a caller; authorization governs that caller's object/action on every relevant server request. A hidden button is not access control. Render untrusted text safely rather than interpreting it as HTML.

Where the app actually has cookie sessions, review HTTPS, cookie attributes, expiry, logout and CSRF protections appropriate to that design. Prefer established components, not homemade cryptography. Inspect dependency and lockfile changes deliberately; a package audit or install does not certify safety. Exposed credentials require provider-side rotation/revocation and impact inspection, not merely deleting a string.

COMMON FAILURE MODES
Invented field metrics, performance folklore, applying unrelated framework recipes, force-fixing dependencies, treating browser validation as authorization, or prescribing backend security for a backend that does not exist.

STOP CONDITIONS: Suspected active leak, unknown authorization boundary, untrusted upload/executable content or a required security audit. Preserve evidence and prepare a bounded Build investigation; no autonomous remediation.
WHAT NOT TO CLAIM: SECURITY_GUIDANCE != SECURITY_AUDIT; no complete vulnerability absence, legal compliance or unmeasured speed improvement.
NEXT ACTION / OUTPUT SHAPE: Observed symptom/boundary; hypothesis; one measurement or scoped repair; acceptance and unresolved risk.
SOURCE STATUS: Distribution guidance. Owner source paths are indexed in knowledge.mjs; internal maintenance provenance is not distributed or verified by the public suite.
LAST VERIFIED: 2026-10-04 research snapshot. RECHECK TRIGGER: Metric/tool/stack, dependency, auth design, new advisory or deployment change.
