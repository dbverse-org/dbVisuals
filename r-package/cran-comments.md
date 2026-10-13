# Submission notes: dbVisuals 0.1.0

This is a new submission.

## Test environments

To be completed before submission:

* local macOS (aarch64), R release
* win-builder (R-devel and R-release)
* R-hub (Linux, macOS, Windows)

## R CMD check results

To be completed before submission. A partial `R CMD check --as-cran` on
Windows 11 (R 4.6.0) built and installed the package and passed the
namespace, dependency, file-name and installation checks; the expected NOTEs
are below.

## Expected NOTEs

* New submission.
* Installed size. `inst/sqlrooms/` (about 17 MB unpacked; the source tarball is
  under 5 MB) is the prebuilt SQL Rooms Canvas web application that
  `launchBrowser()` serves from a local httpuv process, and
  `inst/htmlwidgets/lib/mosaic_gl/` (about 2 MB) is the bundle of the
  `mosaic_gl()` htmlwidget. The package does not work without them.

## Bundled JavaScript

Both browser applications are minified bundles of permissively licensed
libraries (MIT, BSD, ISC, Apache 2.0). Every bundled component and its
copyright holder is listed in `inst/COPYRIGHTS`, and the copyright holders are
named in `Authors@R` with role `cph`.

* Source of the `mosaic_gl()` bundle: shipped in the package, `inst/viewer-src/`
  (with `package-lock.json`; `npm ci && npm run build` reproduces it).
* Source of the Canvas application: `frontend/sqlrooms-ai/` in
  https://github.com/dbverse-org/dbVisuals (with `package-lock.json`).

## Internet access

The browser components load DuckDB-WASM from jsDelivr when displayed; this is
stated in the Description and in `?mosaic_gl`. Examples and tests do not
require network access: examples that would open a browser or start a server
are wrapped in `\dontrun{}` or `if (interactive())`.

## Installing packages

`install_dbvisuals_deps()` installs optional packages only after interactive
consent (`readline()` confirmation); in non-interactive sessions it reports
what is missing and installs nothing.

## URLs

https://github.com/dbverse-org/dbVisuals is made public before this submission
is sent.
