# TextGraph renderer

Anonymous PNG and SVG HTTP rendering for [TextGraph](https://textgraph.dev). The
service uses the public `@drawmotive/textgraph` SDK and packaged fonts. It requires
Node.js 22.23.2 or later, without a browser, private source checkout, or .NET host.

The current registry lock installs SDK `0.2.2-alpha.2`, which does **not** include
native SVG. Workers therefore report `UNSUPPORTED_CAPABILITY`, `/health` returns
503, and rendering remains unavailable. Deployment requires a published SDK
with `textgraph-render-svg-v1` and an updated registry lock. Unit tests exercise
the HTTP and Worker boundaries with an injected engine; they do not claim that
the old registry runtime supports SVG.

## Run

```bash
npm ci
npm test
npm start
```

The listener defaults to port 8080. A ready Worker pool serves:

```bash
curl http://localhost:8080/health
curl --fail-with-body http://localhost:8080/api/v1/render/png \
  -H 'Content-Type: application/json' \
  -d '{"source":"A: Start\nB: Finish\nA -> B"}' -o diagram.png
curl --fail-with-body http://localhost:8080/api/v1/render/svg \
  -H 'Content-Type: application/json' \
  -d '{"source":"A: 中文开始 😀","language":"zh-CN"}' -o diagram.svg
```

Both POST routes accept a JSON object with `source` (string), `padding`
(nonnegative number, default 10), and `language` (optional language tag such as
`zh-CN`). PNG additionally accepts `scale` (positive number, default 1) and
`maxWidth` (positive safe integer). Numbers must survive the SDK's float32
boundary. SVG rejects PNG options; both routes reject unknown properties.
Sources pass unchanged to the SDK. Unsupported diagram types return compiler
diagnostics. SVG is a native vector document with logical padded dimensions.

Successful responses use `image/png` or `image/svg+xml; charset=utf-8`, with
`X-TextGraph-Warning-Count`. All responses use `Cache-Control: no-store` and
arbitrary-origin CORS without credentials. OPTIONS preflight is supported.
Sources and image bytes are neither persisted nor logged.

| Status | Meaning |
| --- | --- |
| 400 | Invalid JSON, UTF-8, or options |
| 408 | Body read deadline exceeded |
| 413 | Body byte limit exceeded, including chunked uploads |
| 415 | Content-Type is not application/json |
| 422 | Compilation, layout, or render diagnostics |
| 429 | All available Workers occupied; Retry-After: 1 |
| 503 | Worker startup, crash, shutdown, or operational failure |
| 504 | Render deadline exceeded |
| 500 | Unexpected service operation failure |

Errors are JSON `{code,message}`; 422 also includes compiler `diagnostics` with
original zero-based UTF-16 locations. Operational exception details are omitted.
Unknown routes return 404 and incorrect methods return 405.

## Capacity and configuration

Each Worker initializes its SDK once and warms Latin, Chinese, Japanese, and
emoji fonts in both formats before advertising readiness. Font and theme bytes
come from installed packages; network font access is disabled. Worker slots have
no render queue. Timeout or client disconnect terminates active native WASM and
initializes a replacement before capacity is usable again. Crashes and operational
failures also replace the Worker. A failed initialization remains unavailable
until process restart, preventing a rapid restart loop. SIGTERM/SIGINT stop the
listener, reject active renders, and terminate Workers.

`GET /health` reports `{status,capacity,ready,busy,unavailable}`. Initialized busy
Workers count as ready, so health remains responsive and healthy during rendering.
It returns 503 when no Worker is initialized.

| Environment variable | Default | Accepted values |
| --- | --- | --- |
| PORT | 8080 | 1..65535 |
| HOST | 0.0.0.0 | Nonempty bind address |
| WORKER_COUNT | 1 | 1..8 |
| RENDER_TIMEOUT_MS | 30000 | Positive integer, at most 2147483647 |
| WORKER_STARTUP_TIMEOUT_MS | 30000 | Positive integer, at most 2147483647 |
| BODY_LIMIT_BYTES | 65536 | Positive integer, at most 2147483647 |
| BODY_TIMEOUT_MS | 10000 | Positive integer, at most 2147483647 |

Invalid settings fail before startup. Scale parallelism through Workers or
independent containers according to available memory.

## Container verification

```bash
docker build --platform linux/amd64 -t textgraph-renderer:local .
npm run smoke -- --image textgraph-renderer:local --expected-version 0.1.0-alpha.1
```

The multi-stage Debian image installs only locked public npm dependencies, retains
dependency/font licenses, runs as `node`, exposes 8080, and supports a read-only
filesystem. Smoke starts that image with a read-only root, dropped capabilities,
and no-new-privileges, then verifies real PNG/SVG, Chinese/emoji, diagnostics, CORS
and health. It inspects the actual installed service/SDK/producer identity against
`/app/provenance.json`. OCI version labels, when supplied through `VERSION`, must
match the package. `REVISION` records the service commit. The provenance label
points to the generated metadata rather than hardcoding an SDK identity.

To check an existing listener:

```bash
npm run smoke -- --base-url http://localhost:8080
```

Image smoke intentionally fails until the registry SDK includes native SVG. A
local SDK candidate can be verified in a disposable context, but is not a
registry-published dependency or a releasable image.

Service code is MIT; installed SDK and font packages retain their own licenses.
