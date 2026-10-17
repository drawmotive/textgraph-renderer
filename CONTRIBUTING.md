# Contributing

Use Node.js 22.23.2 or later in the Node 22 line and its bundled npm. Run
`npm ci` and `npm test` with the committed lockfile. No private C# source,
browser, or .NET installation is required for service development.

Keep rendering in the public SDK and sources unchanged across the service
boundary. Changes to worker cancellation, request validation, and release
identity need relevant regression tests. For container changes, run the Docker
build and `npm run smoke` commands in README.md. Maintained public examples and
preview images may be committed under `docs/`. Do not commit user request
sources, arbitrary rendered output, credentials, or generated receipts.

Submit ordinary issues through the
[TextGraph tracker](https://github.com/drawmotive/textgraph/issues) and code
changes as pull requests to this repository. Use SECURITY.md for private reports.
