# Register a lazy tbl or dbMatrix/dbSpatial as a VIEW in the SQL Rooms database

Creates a SQL \`VIEW\` (optionally \`TEMPORARY\`) over \`x\` in the
connection associated with the current SQL Rooms session. No data is
materialized: the view is a lazy alias that the SPA /
\`/api/arrow-query\` can query.

## Usage

``` r
sqlrooms_register(name, x, project = NULL, temporary = FALSE, overwrite = TRUE)
```

## Arguments

- name:

  Character. View name to create.

- x:

  A lazy \`tbl\`, dbMatrix/dbSpatial, or data.frame.

- project:

  Optional. A \`dbProject\` R6 object or \`DBIConnection\`. Defaults to
  whatever was passed to \[launchBrowser()\].

- temporary:

  Logical. Create a \`TEMPORARY VIEW\` (default \`FALSE\`). Persisted
  (non-temporary) views are written to the database file and are visible
  to the SPA after the next page reload.

- overwrite:

  Logical. Use \`CREATE OR REPLACE VIEW\` (default \`TRUE\`).

## Value

Invisibly, a \`dplyr::tbl()\` pointing at the new view, or \`TRUE\`.

## Details

Accepted inputs: - \`tbl_lazy\` / \`tbl_sql\`: rendered via
\`dbplyr::sql_render()\`. - \`dbMatrix\` / \`dbSpatial\` (or any S4 with
a \`\[\]\` extractor returning a \`tbl\`): the underlying lazy tbl is
extracted via \`x\[\]\`. - \`data.frame\`: forwarded to
\[sqlrooms_export_table()\] (materializes).

## Examples

``` r
if (FALSE) { # \dontrun{
library(dplyr)
tbl(con, "cells") |>
  filter(x > 0) |>
  sqlrooms_register("cells_pos", x = _)
} # }
```
