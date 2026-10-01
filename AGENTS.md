# TextGraph renderer

- Use Node.js 22.23.2 or later and standard npm; install with committed lockfile via npm ci.
- Keep service independent of private source, .NET hosts, browsers, and local file/workspace dependencies. Production dependencies must resolve from public npm.
- Use TDD for behavior changes and run npm test (serial native node:test) before committing. Unit tests use injected Worker engines; real runtime/container smoke is a separate required release check.
- Source must pass unchanged to the SDK. Never add diagram-type, fixture, node-ID, or image-specific fallbacks. Require textgraph-render-svg-v1 rather than simulating SVG from PNG.
- Preserve zero-based UTF-16 compiler locations and expose only sanitized service-owned operational errors. Do not log or persist sources or images.
- Worker deadline/cancellation must terminate active Worker before replacement capacity is available. Do not add an unbounded queue or immediate startup retry loop.
- Font/theme inputs must remain packaged assets, with network fallback disabled. Preserve dependency/font licenses in containers.
- Use an isolated task worktree/branch under ~/worktree for edits, builds, and tests. Commit verified work there. Do not merge main, push, publish packages/images, or delete branches/worktrees unless explicitly requested.
- Independent agents must use separate worktrees. Keep changes small and document phase-boundary authority and non-obvious safety invariants.
