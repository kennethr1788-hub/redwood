# Present framing and captions

TOPIC: studio.framing-captions
PURPOSE: Preserve visible proof and understandable captions in the actual viewing format.
WHEN TO USE: Portrait crops, tiny UI, focus/zoom, captions, safe zones or subtitle timing.
REQUIRED FACTS: Ratio and fit/cover setting; essential action/result; source readability; actual frame/playback observations; cue text/timing; destination placement.

STABLE PRINCIPLES
Keep both the action and enough context to understand it. Filling the canvas is less important than preserving proof. More zoom cannot recover detail absent from the recording. Captions should accurately convey speech, relevant sound and speaker identity in sync with the audio. Automatically generated text requires review; validation alone does not establish readability.

DECISION TREE
For a bad portrait crop, inspect the essential UI against cover/focus. Try fit if cover removes proof. Fit shows the whole source and suppresses zoom for that ratio. If fit makes text too small, plan a narrower recording or a simpler workflow. Use focus blocks for meaningful beats, not every cursor movement. Inspect landscape and portrait separately; one successful ratio does not prove the other.

For captions, inspect the longest cue at normal phone size, with speech and important UI visible. Check accuracy, timing, line breaks, contrast and interference with controls. Split/correct phrases without removing meaning. Present's renderer controls caption styling/placement and may ellipsize overflow; it has no arbitrary font/position editor. The saved character limit is not a reading-speed or completeness guarantee.

SRT/VTT input uses original-source timing; exported sidecars follow retained output timing. Match the sidecar to its render, and do not reimport an output-time sidecar as original-source timing. Caption import does not supply aligned-word provenance for transcript cuts. Cutting through speech can leave mechanically remapped caption text that still needs semantic review.

COMMON FAILURE MODES
Zooming to solve fit behavior; treating a local inset guide as a certified platform safe zone; treating burned captions as selectable captions; double captions at the destination; assuming cropped sensitive pixels are removed from the original media.

STOP CONDITIONS: Unreadable proof, lost speech, private source pixels or unsupported styling needs. Present has no redaction tool; rerecord sensitive material safely. Recheck actual platform overlays/crop before delivery.
WHAT NOT TO CLAIM: Current universal safe-zone pixels, automatic accessibility compliance or native subtitle support at an uninspected destination.
NEXT ACTION / OUTPUT SHAPE: Concrete framing/caption defect; preserved proof; one setting/text/timing change; inspect both ratios and final playback.
SOURCE STATUS: Distribution guidance. Owner source paths are indexed in knowledge.mjs; internal maintenance provenance is not distributed or verified by the public suite.
LAST VERIFIED: 2026-10-04. RECHECK TRIGGER: Renderer/importer, captions, aspect/placement or destination UI changes.
