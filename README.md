# Redwood

**Build. Present. Grow.**

Redwood is a local workbench for moving from a product idea or supported app to a working build, a clear demonstration, and reviewed campaign files. Build, Present and Grow own their work; Advisor provides supporting guidance and helps you choose the next step.

Redwood is designed to use your existing coding and AI tools instead of requiring a second Redwood AI subscription. Native Advisor conversations require your own supported, authenticated Codex/ChatGPT account and remain subject to its limits. Deterministic local help and reviewed manual coding handoffs work without a model response.

**Source-available for evaluation; not open source.** See [Community Evaluation Terms](COMMUNITY_EVALUATION_TERMS.md).

## Prerequisites

The advertised complete verification scope targets **macOS**, with Node.js **24+**, npm, Git, the macOS `sandbox-exec` utility, Playwright Chromium, and native FFmpeg/ffprobe on PATH. The verifier reports missing prerequisites and stops. Other operating systems are not qualified by this release.

Install FFmpeg/ffprobe separately through your trusted package manager. You can instead set `FFMPEG_PATH` and `FFPROBE_PATH` to their installed executable paths. No browser, model, native coding client or media binary is bundled. Dependencies download separately; review them before installation.

## Install

```sh
git clone https://github.com/kennethr1788-hub/redwood.git
cd redwood
for package in launcher products/build products/studio products/grow integrations/media products/build/templates/react; do
  npm ci --prefix "$package" --ignore-scripts --no-audit --no-fund || exit 1
done
(cd products/build && npx --no-install playwright install chromium)
```

The template install prepares the included starter; user projects install their own dependencies after review. Internal package names still use `launchforge` for compatibility.

## Start

Run these in four separate terminals from the repository root:

```sh
npm --prefix launcher run dev
```

```sh
npm --prefix products/build start
```

```sh
npm --prefix products/studio start
```

```sh
npm --prefix products/grow start
```

| Surface | Local URL |
| --- | --- |
| Redwood / Advisor | http://127.0.0.1:4191 |
| Build | http://127.0.0.1:4177 |
| Present | http://127.0.0.1:4318 |
| Grow | http://127.0.0.1:4383 |

Keep these local, single-user services on your own machine. The launcher checks and links to product services; it does not start them. Stop each service with Ctrl-C. Local projects and exports are not backed up or published by this repository.

## Try the workflow

1. **Build:** create the supported React/TypeScript/Vite starter or import a supported app. Review its brief and portable coding task in your coding tool. Trust local execution only after inspecting the project; run source-bound checks and inspect the preview. A starter or finished model response is not proof of an implemented, verified product.
2. **Present:** import a recording or capture a local web flow. Review cuts, framing and captions, then render and play the local outputs. Export freshness and actual media inspection are separate checks. Automatic transcription needs separately installed model prerequisites; imported captions need none.
3. **Grow:** start a plan from product information without a URL, or deliberately choose a consented site audit. Review evidence, proposals, creative assets and export files. Source changes are handed to Build for review and implementation.
4. **Advisor:** select local deterministic help for an account-free evaluation. Advice and prepared coding prompts do not execute source changes. Native mode requires your own configured client; no creator account state is included.

**EXPORTED != PUBLISHED.** Videos, campaign bundles and calendars are local files. Redwood does not automatically post, schedule campaigns, submit ads, deploy a site or guarantee commercial outcomes. Optional Higgsfield media generation has separate setup, billing, consent and review boundaries; it is not required for local evaluation. ElevenLabs is not required. Provider installation or an old receipt does not establish current authentication or permission.

## Public verification

```sh
./scripts/verify-redwood.sh
```

The success marker is **`REDWOOD_PUBLIC_DISTRIBUTION_VERIFICATION=PASS`**. This is explicitly the distribution scope: Build checks/restore/typecheck/build; Present tests and synthetic local capture; Grow tests/typecheck; offline integration/Advisor tests; hash-bound legacy runtime regressions; launcher tests/build/typecheck; five browser programs; and distribution-integrity negatives.

The public suite excludes one internal Advisor maintenance-provenance test and five internal connector provenance tests, along with the documents those checks require. It does not certify unpublished provenance. Historical account replay is replaced by clearly synthetic browser data. Eleven retained legacy runtime inputs remain byte-for-byte hash-bound. Missing or changed fixtures fail. Two pre-existing Present opt-ins (ordinary capture and a downloaded ASR model) remain skipped; the separate capture suite runs. No live provider call is required or advertised.

`PUBLIC_SOURCE_MANIFEST.json` binds shipped paths, bytes and modes. The verifier checks it before and after execution, rejects unexpected source and broken local Git metadata, and works from a no-Git source extraction without discovering an unrelated parent repository. The manifest is an integrity inventory, not a cryptographic publisher signature. Verification never repairs or resets source. Logs are written beneath `launcher/.local`.

This is a competition evaluation build, not a production service. Some rendered media retains earlier internal branding; the final application aesthetic does not imply a new rendered-media review. AI account qualification, paid-provider behavior, downloaded speech models, other operating systems and competition submission are outside this public check.

## Third-party components

Third-party components retain their own licenses and notices, including the shipped font notices and files under `products/studio/docs/licenses`. Build and its starter include their third-party notice files. Evaluation terms apply only to the original Redwood material and do not override those licenses. Dependencies, Chromium, FFmpeg/ffprobe, models and native coding clients install separately.
