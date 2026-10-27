# Launch the dbVisuals browser

Opens a browser-based dbVisuals workspace for interactive data
exploration with support for deck.gl and Mosaic visualizations. A local,
authenticated server provides access to the selected DuckDB database;
arbitrary R code execution and AI features are not exposed.

## Usage

``` r
launchBrowser(
  db_path = NULL,
  project = NULL,
  port = 3001,
  frontend_port = 5173,
  browser = TRUE,
  daemon = FALSE,
  host = "127.0.0.1"
)
```

## Arguments

- db_path:

  Optional path to a DuckDB database file. If NULL, starts a standalone
  DuckDB-WASM workspace in the browser, independent of R data.

- project:

  Optional \`dbProject\` R6 object (from the \`dbProject\` package) or a
  \`DBIConnection\`. When supplied, \`db_path\` is derived from the
  connection's underlying DuckDB file. Mutually exclusive with
  \`db_path\`.

- port:

  Port number for the R server when a database file is supplied
  (default: 3001)

- frontend_port:

  Port number for the frontend server (default: 5173)

- browser:

  Logical. Open browser automatically (default: TRUE)

- daemon:

  Logical. Run server in background (default: FALSE)

- host:

  Host address (default: "127.0.0.1")

## Value

Invisibly returns a list with server information.

## Examples

``` r
if (FALSE) { # \dontrun{
# Launch a standalone browser workspace
launchBrowser()

# Launch with a specific GiottoDB database
launchBrowser(db_path = "giottodb-visium.db")

# Launch without opening browser
launchBrowser(browser = FALSE)
} # }
```
