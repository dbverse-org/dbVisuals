# Submission notes: dbVisuals 0.1.0

This is a new submission.

## Resubmission

This is a resubmission. Thank you for the review. In this version:

* Added `\value` to `sqlrooms_export_table.Rd`, describing what the function
  returns and its side effect.
* The package no longer installs packages anywhere: `install_dbvisuals_deps()`
  has been removed, and the vignettes no longer contain package installation
  code (installation is described in the text instead). The package also never
  installs DuckDB extensions; it only loads ones the user has installed.
* Replaced every `\dontrun{}`:
  - `sqlrooms_export_table()`, `sqlrooms_register()` and
    `dbvisuals_export_htmlwidget()` examples now run unwrapped (each well
    under 5 s; they need only suggested packages, checked with
    `requireNamespace()`, and write only to `tempdir()`).
  - `launchBrowser()` and `stop_sqlrooms()` start a local web server and open
    a browser, so their examples are wrapped in `if (interactive())`.

An earlier resubmission also addressed the pre-test NOTE "Running R code in
'testthat.R' had CPU time 2.8 times elapsed time" on Debian.

## Test environments

* local Ubuntu (WSL2), R 4.6.0, with the PDF manual
* win-builder: R-release (4.6.1) and R-devel
* R-hub: linux, windows and macos-arm64 (R-devel), ubuntu-clang, ubuntu-gcc12,
  donttest, nosuggests, vnu
* GitHub Actions: macOS and Windows (R release); Ubuntu (R devel, release and
  oldrel-1)

## R CMD check results

0 errors | 0 warnings | 1 NOTE

* New submission.
* "Possibly misspelled words in DESCRIPTION: omics". "Spatial omics" is the
  standard name of the field the 'GiottoDB' example comes from.
* Installed size may be reported on some platforms; see below.

## Installed size

`inst/sqlrooms/` (about 17 MB unpacked; the source tarball is under 5 MB) is
the prebuilt dbVisuals web application that `launchBrowser()` serves from a
local httpuv process, and `inst/htmlwidgets/lib/mosaic_gl/` (about 2 MB) is the
bundle of the `mosaic_gl()` htmlwidget. The package does not work without them.

## Bundled JavaScript

Both browser applications are minified bundles of permissively licensed
libraries (MIT, BSD, ISC, Apache 2.0). Every bundled component and its
copyright holder is listed in `inst/COPYRIGHTS`, which the `Copyright` field of
DESCRIPTION refers to.

* Source of the `mosaic_gl()` bundle: shipped in the package, `inst/viewer-src/`
  (with `package-lock.json`; `npm ci && npm run build` reproduces it).
* Source of the web application: `frontend/sqlrooms-ai/` in
  https://github.com/dbverse-org/dbVisuals (with `package-lock.json`).

## Internet access

The browser components load DuckDB-WASM from jsDelivr when displayed; this is
stated in the Description and in `?mosaic_gl`. Examples, tests and vignettes do
not require network access: examples that would open a browser or start a
server are wrapped in `if (interactive())`, and vignette code is not evaluated.
