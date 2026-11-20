import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "mayankjain1815-commits/OmniRoute";
const UPSTREAM = "diegosouzapw/OmniRoute";

const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

test("GitHub badges in README describe this repository, not an unrelated upstream", () => {
  // This repository is standalone (fork: false, no parent). Any GitHub badge that
  // names an OmniRoute repository must therefore point at this one — otherwise the
  // header silently advertises somebody else's star count and CI status.
  const omniRouteRepoBadges = [
    ...readme.matchAll(/https:\/\/img\.shields\.io\/github\/[a-z-]+\/([^?\s)\]]+)/gi),
    ...readme.matchAll(/https:\/\/github\.com\/([^\s)/]+\/[^\s)/]+)\/actions\/workflows\//gi),
  ].map((m) => m[1]).filter(Boolean);

  const wrong = omniRouteRepoBadges.filter(
    (ref) => ref.toLowerCase().endsWith("/omniroute") && !ref.toLowerCase().startsWith("mayankjain1815-commits/")
  );

  assert.deepEqual(
    [...new Set(wrong)],
    [],
    `README has GitHub badges for another OmniRoute repository: ${[...new Set(wrong)].join(", ")}`
  );
});

test("README exposes live status badges for this repository", () => {
  const badges = [
    `${REPO}/actions/workflows/build.yml/badge.svg`,
    `${REPO}/actions/workflows/nightly-property.yml/badge.svg`,
    `${REPO}/actions/workflows/nightly-schemathesis.yml/badge.svg`,
    `https://img.shields.io/github/license/${REPO}`,
    `https://img.shields.io/github/stars/${REPO}`,
    `https://img.shields.io/github/forks/${REPO}`,
    `https://img.shields.io/github/contributors/${REPO}`,
  ];

  for (const badge of badges) {
    assert.ok(readme.includes(badge), `README is missing badge: ${badge}`);
  }
});

test("header Stars badge links to this repository", () => {
  const starsBadge = readme.match(/\[!\[Stars\]\(https:\/\/img\.shields\.io\/github\/stars\/[^)]*style=social[^)]*\)\]\(([^)]+)\)/);
  assert.ok(starsBadge, "header Stars badge is missing");
  assert.equal(
    starsBadge[1],
    `https://github.com/${REPO}`,
    `header Stars badge must link to ${REPO}, not ${UPSTREAM}`
  );
});
