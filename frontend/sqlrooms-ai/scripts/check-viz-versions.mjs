#!/usr/bin/env node
// Verifies that the shared deck.gl + Mosaic runtime versions stay aligned across
// the dbverse visualization stack, against the contract declared in
// <repo>/versions.json. The dbVisuals2 frontend is the hard-gated anchor; the R
// export targets (rDeckgl, rMosaic) and mosaic.gl are reported and gated against
// regressions, with a known-deviation ledger so existing drift stays visible
// without breaking CI. Sibling packages that are not checked out are skipped.
//
// Zero runtime dependencies (Node builtins only) so it runs in CI before any
// install step. Run with: npm run test:versions
import {readFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..', '..');
const versionsPath = path.join(repoRoot, 'versions.json');

const spec = JSON.parse(readFileSync(versionsPath, 'utf8'));
const {contract, manifests, knownDeviations = []} = spec;

// ── Minimal semver range matcher (supports `^`, exact, and `>=a <b` compounds) ─
function parseVer(value) {
  const match = String(value)
    .trim()
    .replace(/^[v=]+/, '')
    .match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function cmp(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
function satisfiesOne(ver, comparator) {
  const comp = comparator.trim();
  if (!comp || comp === '*') return true;
  if (comp.startsWith('^')) {
    const base = parseVer(comp.slice(1));
    if (!base || cmp(ver, base) < 0) return false;
    let upper;
    if (base[0] > 0) upper = [base[0] + 1, 0, 0];
    else if (base[1] > 0) upper = [0, base[1] + 1, 0];
    else upper = [0, 0, base[2] + 1];
    return cmp(ver, upper) < 0;
  }
  const m = comp.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  const op = (m && m[1]) || '=';
  const base = parseVer(m ? m[2] : comp);
  if (!base) return false;
  const c = cmp(ver, base);
  if (op === '>=') return c >= 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  if (op === '<') return c < 0;
  return c === 0;
}
function satisfies(version, range) {
  const ver = parseVer(version);
  if (!ver) return false;
  return range
    .trim()
    .split(/\s+/)
    .every((part) => satisfiesOne(ver, part));
}
function cleanVersion(value) {
  if (value == null) return null;
  const parsed = parseVer(value);
  return parsed ? parsed.join('.') : null;
}

// ── Per-manifest version extraction ──────────────────────────────────────────
function readNpmLockVersion(file, depName) {
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  const entry = lock.packages?.[`node_modules/${depName}`];
  return entry?.version ?? null;
}
function readNpmPackageVersion(file, depName) {
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const raw =
    pkg.dependencies?.[depName] ??
    pkg.devDependencies?.[depName] ??
    pkg.peerDependencies?.[depName] ??
    null;
  return cleanVersion(raw);
}
function readYamlBundleVersions(file) {
  const text = readFileSync(file, 'utf8');
  const out = {};
  for (const block of text.split(/-\s*name:/).slice(1)) {
    const name = block.match(/^\s*([^\n]+)/);
    const version = block.match(/version:\s*([^\n'"]+)/);
    if (name && version) out[name[1].trim()] = version[1].trim();
  }
  return out;
}
function extractVersion(kind, file, locator) {
  if (kind === 'npm-lock') return readNpmLockVersion(file, locator);
  if (kind === 'npm-package') return readNpmPackageVersion(file, locator);
  if (kind === 'htmlwidget-yaml') {
    const map = readYamlBundleVersions(file);
    return cleanVersion(map[locator]);
  }
  throw new Error(`Unknown manifest kind: ${kind}`);
}

function findDeviation(pkgName, dep, version) {
  return knownDeviations.find(
    (d) =>
      d.package === pkgName &&
      d.dependency === dep &&
      cleanVersion(d.version) === cleanVersion(version),
  );
}

// ── Run checks ───────────────────────────────────────────────────────────────
const rows = [];
let failures = 0;
let warnings = 0;
let skipped = 0;

for (const [pkgName, manifest] of Object.entries(manifests)) {
  const file = path.resolve(repoRoot, manifest.path);
  const isHard = manifest.severity === 'hard';
  if (!existsSync(file)) {
    if (isHard) {
      rows.push([pkgName, '(manifest)', '—', 'MISSING', manifest.path]);
      failures += 1;
    } else {
      rows.push([pkgName, '(manifest)', '—', 'skip', 'not checked out']);
      skipped += 1;
    }
    continue;
  }
  for (const [dep, locator] of Object.entries(manifest.resolve)) {
    const range = contract[dep];
    let version;
    try {
      version = extractVersion(manifest.kind, file, locator);
    } catch (error) {
      rows.push([pkgName, dep, '?', 'ERROR', String(error.message)]);
      failures += 1;
      continue;
    }
    if (!version) {
      rows.push([pkgName, dep, '—', isHard ? 'MISSING' : 'skip', `no ${locator}`]);
      if (isHard) failures += 1;
      else skipped += 1;
      continue;
    }
    if (satisfies(version, range)) {
      rows.push([pkgName, dep, version, 'ok', `satisfies ${range}`]);
      continue;
    }
    const deviation = !isHard && findDeviation(pkgName, dep, version);
    if (deviation) {
      rows.push([pkgName, dep, version, 'WARN', `known deviation (want ${range})`]);
      warnings += 1;
    } else {
      rows.push([
        pkgName,
        dep,
        version,
        'FAIL',
        `violates ${range}${isHard ? ' (anchor)' : ' (new drift)'}`,
      ]);
      failures += 1;
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const widths = [0, 1, 2, 3].map((i) =>
  Math.max(...rows.map((r) => String(r[i]).length)),
);
const pad = (s, w) => String(s).padEnd(w);
console.log(`\nViz runtime version parity (contract anchor: ${spec.anchor})\n`);
for (const r of rows) {
  const status =
    r[3] === 'ok'
      ? '✓'
      : r[3] === 'WARN'
        ? '!'
        : r[3] === 'skip'
          ? '·'
          : '✗';
  console.log(
    `  ${status} ${pad(r[0], widths[0])}  ${pad(r[1], widths[1])}  ${pad(
      r[2],
      widths[2],
    )}  ${r[4]}`,
  );
}
console.log(
  `\n${failures} failure(s), ${warnings} known deviation(s), ${skipped} skipped.\n`,
);

if (warnings > 0) {
  console.log('Known deviations (tracked tech-debt, see versions.json):');
  for (const d of knownDeviations) {
    console.log(`  - ${d.package} ${d.dependency}@${d.version}: ${d.reason}`);
  }
  console.log('');
}

if (failures > 0) {
  console.error(
    'Version parity check FAILED. Update versions.json `contract` and bump the ' +
      'affected bundle in the same change, or record an intentional deviation in ' +
      '`knownDeviations`.',
  );
  process.exit(1);
}
console.log('Version parity check passed.');
