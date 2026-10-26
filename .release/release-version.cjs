const assert = require('node:assert/strict');

const numeric = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.]([0-9])$/;
const historical = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(?:-alpha[.](0|[1-9][0-9]*))?$/;

/** Numeric identities and maturity are separate authorities. Explicit channels
 * permit stable patch releases; unannotated historical receipts keep their
 * original patch-based interpretation. */
function assertReleaseVersion(version) {
  assert.equal(typeof version, 'string', 'Release version must be a string');
  assert.match(version, numeric, 'Use numeric a.b.c with a single-digit patch; suffixes are forbidden');
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
  if (channel !== undefined) {
    assert.ok(['stable', 'alpha'].includes(channel), 'Invalid release channel');
    return channel;
  }
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
