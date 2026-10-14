const assert = require('node:assert/strict');

const numeric = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.]([0-9])$/;
const historical = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-alpha[.](0|[1-9][0-9]*))?$/;

/** New product identities share one numeric sequence: patch zero is stable,
 * patches one through nine are previews. Old receipts remain readable only
 * through an explicit legacy boundary; they cannot authorize a new release. */
function assertReleaseVersion(version) {
  assert.equal(typeof version, 'string', 'Release version must be a string');
  assert.match(version, numeric, 'Use a.b.0 for stable or a.b.1 through a.b.9 for preview; suffixes are forbidden');
  return version;
}
function releaseChannel(version, { legacy = false } = {}) {
  if (legacy) {
    assert.match(version, historical, 'Invalid historical release version');
    return version.includes('-') ? 'alpha' : 'stable';
  }
  assertReleaseVersion(version);
  return version.endsWith('.0') ? 'stable' : 'alpha';
}
function releaseTag(version, options) {
  return releaseChannel(version, options) === 'stable' ? 'latest' : 'alpha';
}

/** Registry history uses ordinary numeric ordering, with legacy suffixes below
 * their historical base version. BigInt avoids rounding large version fields. */
function compareReleaseVersions(left, right) {
  const parse = version => {
    assert.match(version, historical, 'Invalid release history version');
    const [main, alpha] = version.split('-alpha.');
    return [...main.split('.').map(BigInt), alpha === undefined ? 1n : 0n, BigInt(alpha ?? 0)];
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
module.exports = { assertReleaseVersion, releaseChannel, releaseTag, compareReleaseVersions };
