# Build usability and accessibility

TOPIC: build.ux-accessibility
PURPOSE: Improve the critical task's usability with specific observable checks.
WHEN TO USE: Confusing navigation, forms, mobile layouts, keyboard/focus problems or “is this accessible?”
REQUIRED FACTS: User task; actual interface/source observations; input method; viewport/zoom; relevant standard scope; known defects.

STABLE PRINCIPLES
Use the user's vocabulary, a clear primary action and visible location/status. Ask only for information needed by the task. Labels explain purpose; placeholder text alone is not a dependable label. Preserve appropriate entered values after an error. Distinguish loading, no records, no matches, failed requests and confirmed success. A click is not proof that a submission succeeded.

DECISION TREE
Choose one meaningful journey. Inspect headings, reading order, labels and action consequences. Navigate with keyboard and check visible focus, logical order and traps, including dialogs/sticky elements. Check narrow width, enlarged text, usable targets and content reflow. Examine text/background and essential control contrast, including error/disabled states. Check validation, empty/loading/error states and recovery. Record a concrete defect and propose one scoped Build task.

Prefer native semantics and associated labels; group related controls and associate field errors with inputs. Status updates should be available without relying only on color or visual position. Let users review/correct consequential inputs. Reduced-motion support should remove unnecessary movement without hiding feedback. Meaningful media needs appropriate alternatives.

A screenshot may reveal clipping or contrast concerns but cannot prove keyboard behavior, semantic labels, screen-reader output or task persistence. Pair a targeted automated check with manual interaction where appropriate. Accessibility checks are scoped evidence, not a binary judgment based on a polished page.

COMMON FAILURE MODES
Treating a clean scanner as complete accessibility; decorative changes before a broken form; low-contrast status conveyed only by color; moving focus unexpectedly; shrinking desktop content instead of preserving a usable mobile task; promising conversion uplift without a test.

STOP CONDITIONS: Missing interface observations, inaccessible critical path, unclear audience needs or a request for legal certification. Name untested areas and request the smallest relevant observation.
WHAT NOT TO CLAIM: ACCESSIBILITY_CHECK != LEGAL_COMPLIANCE_CERTIFICATION. Advisor does not run a browser check or change source simply by recommending one.
NEXT ACTION / OUTPUT SHAPE: Task and observed defect; affected users; smallest repair; keyboard/mobile/error-state acceptance; limits.
SOURCE STATUS: Distribution guidance. Owner source paths are indexed in knowledge.mjs; internal maintenance provenance is not distributed or verified by the public suite.
LAST VERIFIED: 2026-10-04 research snapshot. RECHECK TRIGGER: Standard/errata, controls, layout, assistive technology or audience changes.
