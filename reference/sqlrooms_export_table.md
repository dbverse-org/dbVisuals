# Export Table to SQL Rooms

Materializes an in-memory \`data.frame\` into the DuckDB database
backing the current SQL Rooms session. When a \`project\` is supplied
(or one was attached at \`launchBrowser()\` time) the table is written
through the project's writable connection. Otherwise the data.frame is
stashed in a package-level cache for later retrieval (back-compat
behavior).

## Usage

``` r
sqlrooms_export_table(name, data, project = NULL, overwrite = TRUE)
```

## Arguments

- name:

  Character. Table name to write.

- data:

  A \`data.frame\`.

- project:

  Optional. A \`dbProject\` R6 object or \`DBIConnection\`. Defaults to
  whatever was passed to \[launchBrowser()\].

- overwrite:

  Logical. Overwrite an existing table (default \`TRUE\`).

## Details

For lazy \`tbl\` objects (dbplyr / dbMatrix / dbSpatial), use
\[sqlrooms_register()\] instead, which creates a SQL VIEW with no data
movement.

## Examples

``` r
if (FALSE) { # \dontrun{
df <- data.frame(x = 1:10, y = rnorm(10))
sqlrooms_export_table("my_table", df)
} # }
```
