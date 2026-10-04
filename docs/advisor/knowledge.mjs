// Metadata only: importing this index does not read a Markdown document.
const deepFreeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
export const KNOWLEDGE_VERSION = 'redwood-expert-r1';
export const KNOWLEDGE_DOCUMENTS = deepFreeze([
  {
    "id": "core.authority",
    "title": "Evidence and authority",
    "path": "core/authority.md",
    "sourcePaths": [
      "integrations/advisor/answer-contracts.mjs"
    ]
  },
  {
    "id": "core.decision",
    "title": "Choose the next action",
    "path": "core/decision.md",
    "sourcePaths": [
      "integrations/advisor/engine.mjs"
    ]
  },
  {
    "id": "core.handoff",
    "title": "Prepare a Build handoff",
    "path": "core/handoff.md",
    "sourcePaths": [
      "products/build/src/agent/handoff.ts"
    ]
  },
  {
    "id": "build.verification-debug",
    "title": "Build verification and diagnosis",
    "path": "build/verification-debug.md",
    "sourcePaths": [
      "products/build/src/core/verification.ts"
    ]
  },
  {
    "id": "build.ux-accessibility",
    "title": "Build usability and accessibility",
    "path": "build/ux-accessibility.md",
    "sourcePaths": [
      "products/build/src/ui/main.tsx"
    ]
  },
  {
    "id": "build.performance-security",
    "title": "Build performance and security",
    "path": "build/performance-security.md",
    "sourcePaths": [
      "products/build/src/preview/lifecycle.ts"
    ]
  },
  {
    "id": "build.coding-source",
    "title": "Build coding and source preservation",
    "path": "build/coding-source.md",
    "sourcePaths": [
      "products/build/src/git/restore.ts"
    ]
  },
  {
    "id": "studio.story-editing",
    "title": "Present story and editing",
    "path": "studio/story-editing.md",
    "sourcePaths": [
      "products/studio/src/timeline/ranges.js"
    ]
  },
  {
    "id": "studio.framing-captions",
    "title": "Present framing and captions",
    "path": "studio/framing-captions.md",
    "sourcePaths": [
      "products/studio/src/render/visual.js"
    ]
  },
  {
    "id": "studio.audio-accessibility",
    "title": "Present audio and accessibility",
    "path": "studio/audio-accessibility.md",
    "sourcePaths": [
      "products/studio/src/audio/review.js"
    ]
  },
  {
    "id": "studio.render-delivery",
    "title": "Present rendering and delivery",
    "path": "studio/render-delivery.md",
    "sourcePaths": [
      "products/studio/src/core/store.js"
    ]
  },
  {
    "id": "grow.market-principles",
    "title": "Grow customer and offer evidence",
    "path": "grow/market-principles.md",
    "sourcePaths": [
      "products/grow/src/intake/index.js"
    ]
  },
  {
    "id": "grow.paid-acquisition",
    "title": "Grow paid acquisition planning",
    "path": "grow/paid-acquisition.md",
    "sourcePaths": [
      "products/grow/src/ui/app.js"
    ]
  },
  {
    "id": "grow.search-discovery",
    "title": "Grow search and discovery",
    "path": "grow/search-discovery.md",
    "sourcePaths": [
      "products/grow/src/ui/app.js"
    ]
  },
  {
    "id": "grow.conversion-retention",
    "title": "Grow conversion and retention",
    "path": "grow/conversion-retention.md",
    "sourcePaths": [
      "products/grow/src/preflight/index.js"
    ]
  },
  {
    "id": "grow.learning-measurement",
    "title": "Grow learning and measurement",
    "path": "grow/learning-measurement.md",
    "sourcePaths": [
      "products/grow/src/measurement/compare.js"
    ]
  },
  {
    "id": "operations.connections",
    "title": "Connections and native accounts",
    "path": "operations/connections.md",
    "sourcePaths": [
      "integrations/connectors/support-doctor.mjs"
    ]
  },
  {
    "id": "operations.continuity",
    "title": "Getting started and resuming",
    "path": "operations/continuity.md",
    "sourcePaths": [
      "integrations/onboarding/index.mjs"
    ]
  }
]);
export const LEGACY_TOPIC_ALIASES = deepFreeze({
  "onboarding.start": "operations.continuity",
  "build.overview": "build.coding-source",
  "build.verification": "build.verification-debug",
  "build.restore": "build.coding-source",
  "studio.overview": "studio.story-editing",
  "studio.editing": "studio.story-editing",
  "studio.rendering": "studio.render-delivery",
  "grow.overview": "grow.market-principles",
  "grow.evidence": "grow.market-principles",
  "grow.campaigns": "grow.conversion-retention",
  "onboarding.connections": "operations.connections",
  "integrations.codex": "operations.connections",
  "integrations.claude": "operations.connections",
  "integrations.higgsfield": "operations.connections",
  "integrations.elevenlabs": "operations.connections",
  "concepts.current-vs-stale": "core.authority",
  "concepts.exported-vs-published": "core.authority",
  "prompt": "core.handoff"
});
export const SUPPORT_INTENTS = deepFreeze([
  {
    "id": "onboarding.start",
    "keywords": [
      "start",
      "getting started",
      "onboarding",
      "begin"
    ],
    "documents": [
      "operations.continuity"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "onboarding.choose_tool",
    "keywords": [
      "choose ai tool",
      "which ai",
      "choosing tool",
      "choose runtime"
    ],
    "documents": [
      "operations.connections",
      "operations.continuity"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "onboarding.existing_repo",
    "keywords": [
      "existing repo",
      "import repo",
      "existing project"
    ],
    "documents": [
      "operations.continuity",
      "build.coding-source"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "onboarding.project_goal",
    "keywords": [
      "project name",
      "desired outcome"
    ],
    "documents": [
      "operations.continuity"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "build.overview",
    "keywords": [
      "build",
      "brief",
      "react app"
    ],
    "documents": [
      "build.coding-source"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "build.verification",
    "keywords": [
      "verification",
      "verify",
      "check",
      "checks"
    ],
    "documents": [
      "build.verification-debug"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "build.verification_failed",
    "keywords": [
      "verification failed",
      "failed check",
      "checks failed",
      "check failed",
      "build failure",
      "check failure"
    ],
    "documents": [
      "build.verification-debug",
      "core.authority"
    ],
    "products": [
      "build"
    ],
    "contract": "BUILD_VERIFICATION_FAILED"
  },
  {
    "id": "build.source_changed",
    "keywords": [
      "source changed",
      "source edits",
      "changed code"
    ],
    "documents": [
      "build.verification-debug",
      "core.authority"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "build.critical_flow",
    "keywords": [
      "critical flow",
      "no flow",
      "user flow"
    ],
    "documents": [
      "build.verification-debug"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "build.preview",
    "keywords": [
      "preview",
      "trust project"
    ],
    "documents": [
      "build.coding-source"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "build.restore",
    "keywords": [
      "restore",
      "restore source",
      "restore review",
      "reset git",
      "git reset",
      "git"
    ],
    "documents": [
      "build.coding-source"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "build.handoff",
    "keywords": [
      "build handoff",
      "prepare agent task",
      "save brief"
    ],
    "documents": [
      "core.handoff",
      "build.coding-source"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "studio.overview",
    "keywords": [
      "studio",
      "recording",
      "capture url"
    ],
    "documents": [
      "studio.story-editing"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.import",
    "keywords": [
      "import recording",
      "upload recording",
      "capture"
    ],
    "documents": [
      "studio.story-editing"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.timeline",
    "keywords": [
      "timeline",
      "trim",
      "split"
    ],
    "documents": [
      "studio.story-editing"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.captions",
    "keywords": [
      "caption",
      "captions",
      "transcript",
      "transcription"
    ],
    "documents": [
      "studio.framing-captions",
      "studio.audio-accessibility"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.silence",
    "keywords": [
      "silence",
      "word cut",
      "cut proposals"
    ],
    "documents": [
      "studio.story-editing",
      "studio.audio-accessibility"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.focus",
    "keywords": [
      "focus",
      "cursor",
      "frame",
      "zoom",
      "portrait",
      "crop",
      "landscape",
      "framing"
    ],
    "documents": [
      "studio.framing-captions"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.render",
    "keywords": [
      "render",
      "rendering",
      "video output"
    ],
    "documents": [
      "studio.render-delivery"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.stale_render",
    "keywords": [
      "stale render",
      "render stale",
      "studio stale",
      "earlier edit"
    ],
    "documents": [
      "studio.render-delivery",
      "core.authority"
    ],
    "products": [
      "studio"
    ],
    "contract": "STUDIO_STALE_RENDER"
  },
  {
    "id": "studio.render_unknown",
    "keywords": [
      "render unavailable",
      "render unknown",
      "job unavailable",
      "render interrupted"
    ],
    "documents": [
      "studio.render-delivery",
      "core.authority"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.export",
    "keywords": [
      "studio export",
      "share page",
      "export video"
    ],
    "documents": [
      "studio.render-delivery",
      "core.authority"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "grow.overview",
    "keywords": [
      "grow",
      "growth",
      "marketing",
      "audience",
      "offer",
      "customer",
      "market"
    ],
    "documents": [
      "grow.market-principles"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.evidence",
    "keywords": [
      "evidence",
      "owned inputs",
      "product claims",
      "source pack"
    ],
    "documents": [
      "grow.market-principles"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.plan",
    "keywords": [
      "campaign plan",
      "growth plan",
      "campaign",
      "strategy"
    ],
    "documents": [
      "grow.market-principles",
      "grow.paid-acquisition"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.creative",
    "keywords": [
      "creative brief",
      "headline",
      "cta",
      "creative"
    ],
    "documents": [
      "grow.learning-measurement",
      "grow.conversion-retention"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.stale",
    "keywords": [
      "grow stale",
      "stale creative",
      "stale preflight"
    ],
    "documents": [
      "grow.learning-measurement",
      "core.authority"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.preflight",
    "keywords": [
      "preflight",
      "creative readability",
      "creative geometry"
    ],
    "documents": [
      "grow.conversion-retention",
      "core.authority"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.export",
    "keywords": [
      "grow export",
      "bundle",
      "calendar",
      "schedule"
    ],
    "documents": [
      "grow.conversion-retention",
      "core.authority"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "connection.state",
    "keywords": [
      "connection",
      "connections",
      "connector",
      "doctor",
      "detected",
      "authenticated"
    ],
    "documents": [
      "operations.connections"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "connection.codex",
    "keywords": [
      "codex"
    ],
    "documents": [
      "operations.connections"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "connection.claude",
    "keywords": [
      "claude"
    ],
    "documents": [
      "operations.connections"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "connection.higgsfield",
    "keywords": [
      "higgsfield"
    ],
    "documents": [
      "operations.connections"
    ],
    "products": [],
    "contract": "HIGGSFIELD_SETUP"
  },
  {
    "id": "connection.elevenlabs",
    "keywords": [
      "elevenlabs"
    ],
    "documents": [
      "operations.connections"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "billing.account",
    "keywords": [
      "subscription",
      "billing",
      "api",
      "quota",
      "account limits"
    ],
    "documents": [
      "operations.connections"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "state.freshness",
    "keywords": [
      "current",
      "stale",
      "freshness"
    ],
    "documents": [
      "core.authority"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "state.unknown",
    "keywords": [
      "unknown",
      "missing state",
      "unavailable state"
    ],
    "documents": [
      "core.authority"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "state.resume",
    "keywords": [
      "resume",
      "where did i leave off",
      "continue",
      "continuity"
    ],
    "documents": [
      "operations.continuity",
      "core.authority"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "export.publishing",
    "keywords": [
      "export",
      "publish",
      "published",
      "hosting",
      "ready to publish"
    ],
    "documents": [
      "core.authority",
      "studio.render-delivery"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "prompt.prepare",
    "keywords": [
      "coding prompt",
      "copy prompt",
      "prepare prompt",
      "coding agent",
      "prompt"
    ],
    "documents": [
      "core.handoff"
    ],
    "products": [],
    "contract": null
  },
  {
    "id": "build.ux",
    "keywords": [
      "accessible",
      "accessibility",
      "keyboard",
      "contrast",
      "forms",
      "mobile",
      "responsive",
      "usability"
    ],
    "documents": [
      "build.ux-accessibility"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "build.performance_security",
    "keywords": [
      "slow",
      "performance",
      "security",
      "secure",
      "lcp",
      "inp",
      "cls",
      "secrets",
      "authentication"
    ],
    "documents": [
      "build.performance-security",
      "build.verification-debug"
    ],
    "products": [
      "build"
    ],
    "contract": null
  },
  {
    "id": "studio.story",
    "keywords": [
      "boring",
      "demo story",
      "opening",
      "first five seconds",
      "first 5 seconds",
      "hook",
      "pacing"
    ],
    "documents": [
      "studio.story-editing",
      "core.decision"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "studio.audio",
    "keywords": [
      "audio",
      "music",
      "speech",
      "sound",
      "loudness",
      "flashing"
    ],
    "documents": [
      "studio.audio-accessibility"
    ],
    "products": [
      "studio"
    ],
    "contract": null
  },
  {
    "id": "grow.paid",
    "keywords": [
      "meta",
      "google ads",
      "google search",
      "performance max",
      "ads",
      "paid acquisition",
      "budget"
    ],
    "documents": [
      "grow.paid-acquisition",
      "grow.market-principles"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.search",
    "keywords": [
      "seo",
      "aeo",
      "ai search",
      "search discovery",
      "search console",
      "content topic",
      "page next"
    ],
    "documents": [
      "grow.search-discovery",
      "grow.market-principles"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.conversion",
    "keywords": [
      "landing page",
      "cro",
      "retention",
      "email",
      "organic social",
      "conversion funnel",
      "form conversion"
    ],
    "documents": [
      "grow.conversion-retention",
      "grow.market-principles"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "grow.measurement",
    "keywords": [
      "ctr",
      "conversions flat",
      "increase budget",
      "measurement",
      "attribution",
      "metrics",
      "test creative",
      "compare results",
      "learning"
    ],
    "documents": [
      "grow.learning-measurement",
      "core.decision"
    ],
    "products": [
      "grow"
    ],
    "contract": null
  },
  {
    "id": "expert.decision",
    "keywords": [
      "next action",
      "what next",
      "what should i do next",
      "decision",
      "choose between",
      "stop doing"
    ],
    "documents": [
      "core.decision",
      "core.authority"
    ],
    "products": [],
    "contract": null
  }
]);
