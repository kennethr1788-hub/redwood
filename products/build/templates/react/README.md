# Your owned app

Requires Node 22.12+ and npm. Install: `npm ci --ignore-scripts`.
Start: `npm run dev`. Check: `npm run typecheck && npm run build && npm test`.
Production files are written to `dist/`; hosting is your choice and a separate action.

The initial three-route starter is deliberately labeled. Open this folder in your existing coding tool and ask it to implement `.launchforge/brief.md`.
Authentication, inference, quotas and billing remain in that tool. %LABEL_UMBRELLA% never calls a model for you.
Your project works without %LABEL_UMBRELLA%. Copy this whole folder (excluding node_modules/dist) or use ordinary Git.
Keep `.launchforge/` to preserve the brief; it is not a runtime dependency.
