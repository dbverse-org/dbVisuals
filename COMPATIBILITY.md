# dbverse Visualization Runtime Compatibility

dbVisuals2 authors visualizations as compact, renderer-agnostic **bridge specs**
and compiles them to Mosaic and deck.gl output. Those same specs are meant to be
exportable to the R htmlwidgets `rMosaic` and `rDeckgl` (and the combined
`mosaic.gl`). That only works if every project renders with compatible versions
of the underlying JavaScript engines.

This file documents how we keep those versions aligned. The machine-checkable
contract lives in [`versions.json`](versions.json) and is enforced by
`npm run test:versions` (and the `frontend-checks` CI workflow).

## The contract and its anchor

The **dbVisuals2 frontend is the anchor**. Its deck.gl and Mosaic versions are
pinned transitively by the `@sqlrooms/*` release it depends on, so they cannot be
bumped independently. Everything else must satisfy the same ranges so a spec
authored in dbVisuals2 renders the same way when exported to R.

Current contract (`versions.json` → `contract`):

| Dependency | Range | Why |
| --- | --- | --- |
| `deck.gl` | `^9.3.0` | deck.gl 9.3 line used by `@sqlrooms/deck` and the GeoArrow layers |
| `@geoarrow/deck.gl-layers` | `0.3.2` | GeoArrow layer API is pre-1.0; pin exactly |
| `@uwdata/mosaic` (vgplot / mosaic-core) | `^0.21.0` | Mosaic version pinned by `@sqlrooms/mosaic` |
| `apache-arrow` | `>=17.0.0 <22.0.0` | Arrow IPC/GeoArrow interop window |

## Current version matrix

| Project | deck.gl | Mosaic | geoarrow-layers | Build manifest |
| --- | --- | --- | --- | --- |
| dbVisuals2 frontend | 9.3.3 | 0.21.1 | 0.3.2 | `package.json` (+ lockfile) ✓ |
| bundled viewer (`r-package/`) | 9.3.2 | 0.25.0 ⚠ | 0.3.2 | `r-package/inst/viewer-src/package.json` + vite ✓ |
| rDeckgl | 9.1.15 ⚠ | — | bundled | `deckgl.yaml` only (opaque bundle) |
| rMosaic | — | 0.21.1 ✓ | — | `mosaic.yaml` only (opaque bundle) |

`rMosaic` already matches the anchor, so Mosaic specs travel cleanly. The two ⚠
rows are tracked in `versions.json` → `knownDeviations`.

## How the check works

`npm run test:versions` reads `versions.json`, then:

1. **Hard-gates the anchor.** The frontend's resolved deck.gl / Mosaic / GeoArrow
   / Arrow versions (from `package-lock.json`) must satisfy `contract`. If a
   `@sqlrooms` upgrade moves them out of range, the check fails until you update
   `contract` (and bump the R bundles) in the same change.
2. **Gates regressions in the export targets.** rDeckgl / rMosaic / mosaic.gl are
   read from their own manifests (`deckgl.yaml`, `mosaic.yaml`,
   `viewer-src/package.json`). A version that violates the contract and is **not**
   listed in `knownDeviations` fails the check. Listed deviations warn only.
3. **Skips siblings that aren't checked out.** In the dbVisuals2 CI the sibling
   repos are absent, so only the anchor is gated. Run it locally (with the sibling
   repos beside this one) to validate the whole stack.

## Known deviations (remediation plan)

- **rDeckgl deck.gl 9.1.15** → bump to the `^9.3` contract. Best done as part of
  the build migration below.
- **mosaic.gl Mosaic 0.25.0** → fine for the standalone widget today; align
  downward (or move the anchor up) when `@sqlrooms` upgrades Mosaic.

## Target architecture: reproducible bundles for rDeckgl / rMosaic

`rDeckgl` and `rMosaic` currently commit **opaque, hand-versioned** bundles
(`inst/htmlwidgets/lib/*.js`) whose only version record is the `htmlwidget` YAML.
The bundled viewer already shows the sustainable pattern and should be the template:

```
inst/viewer-src/package.json   # pinned deck.gl / Mosaic versions (the source of truth)
inst/viewer-src/src/...        # entry that re-exports the upstream engines
npm run build                  # vite -> inst/htmlwidgets/lib/<widget>-bundle.js
```

Migrating both R packages to this layout means:

- versions are declared in a `package.json` the parity check reads directly,
- bundles are reproducible from pinned upstream packages (no forks),
- a `@sqlrooms` bump in dbVisuals2 becomes a one-line version change + rebuild in
  each R package, verified by `test:versions`.

## Spec portability

- **Mosaic specs** emitted by the bridge are standard vgplot/`mosaic-spec` JSON
  (`plot` marks + a `$brush` crossfilter selection). With rMosaic on the same
  Mosaic 0.21.x, they run in `rMosaic::mosaic()` with little or no translation.
- **deck.gl specs** emitted by the bridge are **SQLRooms-flavored** (`@@type`
  GeoArrow layers, `_sqlroomsBinding`, a `datasets` map). They are **not** drop-in
  for `rDeckgl::deckgl()`; the portable contract is the compact `BridgeSpec`
  intent, which a `BridgeSpec -> rDeckgl` compiler should translate (see the
  Phase 6 export targets in `docs/visualization-bridge.md`).
- The R-side export entry point today is `dbvisuals_export_htmlwidget()` in the
  `r-package` (Mosaic specs → rMosaic, deck specs → rDeckgl).

## Distribution (CRAN)

`rDeckgl` and `rMosaic` are published on **CRAN**, so the dbVisuals R package and
the `dbvisuals_export_htmlwidget()` path can depend on them as ordinary CRAN
packages — no `Remotes:`/GitHub install needed. They are currently declared under
`Enhances:` in `r-package/DESCRIPTION` and there is no `Remotes:` field, so they
already resolve from CRAN; promoting them to `Imports:`/`Suggests:` would still
need no GitHub remote. The bundled viewer is **not** a separate CRAN package -- it ships inside this repository's R package -- so it is the
exception if it ever becomes a hard dependency.

Consequence for version parity: the rDeckgl `deck.gl 9.1.15` entry in
`knownDeviations` reflects the **current CRAN release** of rDeckgl, so aligning it
to the contract means cutting a new rDeckgl CRAN release with the rebuilt bundle.
`test:versions` reads local working copies; for release validation it can be
extended to read the CRAN-published `DESCRIPTION`/bundle versions.

## When you change versions

1. Update `versions.json` (`contract`, and `knownDeviations` if intentional).
2. Run `npm run test:versions` until it passes.
3. If you bumped the anchor, bump the matching rDeckgl / rMosaic / mosaic.gl
   bundles and rebuild them in the same change set.
