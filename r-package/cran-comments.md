# Submission notes — dbVisuals 0.1.0

## Test environments

* local macOS 15 (aarch64-apple-darwin20), R 4.5.1 — 0 errors, 0 warnings, 1 NOTE
* (please re-run on win-builder + R-hub before submission)

## R CMD check results

0 errors | 0 warnings | 1 NOTE (new submission)

  > New submission
  > Found the following (possibly) invalid URLs:
  >   https://github.com/dbverse-org/GiottoDB     (private)
  >   https://github.com/dbverse-org/dbVisuals2   (this repo, private)
  >   https://github.com/dbverse-org/dbVisuals2/issues
  >   https://github.com/giotto-suite/Giotto      (moved — kept since the
  >                                                redirect is permanent)

All flagged GitHub repositories will be made public before this submission is
sent to CRAN. The `Giotto` redirect resolves to HTTP 200 already and is the
canonical repository home.

## Bundled SQL Rooms web UI

`inst/sqlrooms/` (~4.4 MB) is the pre-built SQL Rooms single-page application
(MIT-licensed) that `launchBrowser()` serves through a local httpuv process.
The package would not function without it; users do not need network access
to load the UI.

## Optional integrations

Several integration packages (rDeckgl, rMosaic, GiottoDB, dbProject) are
intentionally *not* listed under `Suggests:` because they are not on a
mainstream R package repository. They are loaded conditionally with
`requireNamespace()` from `launchBrowser()` and are installable via the
helper `install_dbvisuals_deps()` which asks for interactive consent before
calling `install.packages()` / `remotes::install_github()`.
