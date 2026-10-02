# Contributing

Use Node.js 22.23.2 or later in the Node 22 line and its bundled npm. Run
`npm ci` and `npm test` with the committed lockfile. No private C# source,
browser, or .NET installation is required for service development.

Keep rendering in the public SDK and sources unchanged across the service
boundary. Changes to worker cancellation, request validation, and release
identity need relevant regression tests. For container changes, run the Docker
build and `npm run smoke` commands in README.md. Do not include diagram sources,
rendered images, credentials, or generated receipts in commits.

Submit ordinary issues through the
[TextGraph tracker](https://github.com/drawmotive/textgraph/issues) and code
changes as pull requests to this repository. Use SECURITY.md for private reports.
