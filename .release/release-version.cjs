const assert = require('node:assert/strict');

const numeric = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/;
const historical = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-alpha[.](0|[1-9][0-9]*))?$/;

/** Every canonical numeric identity is stable. Legacy suffixes remain readable
 * for historical release evidence without defining new numeric release policy. */
function assertReleaseVersion(version) {
  assert.equal(typeof version, 'string', 'Release version must be a string');
  assert.match(version, numeric, 'Use canonical numeric a.b.c; suffixes are forbidden');
  return version;
}
function releaseChannel(version, { legacy = false, channel } = {}) {
  if (legacy) {
    assert.match(version, historical, 'Invalid historical release version');
    const historicalChannel = version.includes('-') ? 'alpha' : 'stable';
    if (channel !== undefined) assert.equal(channel, historicalChannel, 'Historical release channel/version mismatch');
    return historicalChannel;
  }
  assertReleaseVersion(version);
  if (channel !== undefined) assert.equal(channel, 'stable', 'Numeric release channel must be stable');
  return 'stable';
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
