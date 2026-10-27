# dbVisuals R interface

This private source package launches the non-AI Canvas workspace and includes
the separate `mosaic_gl()` linked R widget. It is not a CRAN release.

From the repository root:

```r
remotes::install_local("r-package")
library(dbVisuals)
dashboard <- launchBrowser()                      # standalone DuckDB-WASM
# dashboard <- launchBrowser(db_path = "test.db") # native DuckDB
stop_sqlrooms(dashboard)
```

Native launch requires closing other writer connections to the database first.
It authenticates the local frontend but does not sandbox authorized SQL.
Standalone browser imports are not synchronized to R.

Use `?launchBrowser` and `?mosaic_gl` for their distinct interfaces. The repository
[README](../README.md) covers Canvas development;
[COMPATIBILITY.md](../COMPATIBILITY.md) records runtime and spec boundaries.
