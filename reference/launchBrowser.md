# Launch the dbVisuals browser

Opens a browser-based dbVisuals workspace for interactive data
exploration with support for deck.gl, Mosaic, and R visualizations. The
interface connects to the current R session for executing R code.

## Usage

``` r
launchBrowser(
  db_path = NULL,
  project = NULL,
  port = 3001,
  frontend_port = 5173,
  browser = TRUE,
  daemon = FALSE,
  host = "127.0.0.1",
  agent = FALSE,
  agent_token = NULL,
  agent_allow_write = FALSE,
  agent_allow_r = FALSE,
  agent_max_rows = 1000L
)
```

## Arguments

- db_path:

  Optional path to a DuckDB database file. If NULL, uses an in-memory
  database.

- project:

  Optional \`dbProject\` R6 object (from the \`dbProject\` package) or a
  \`DBIConnection\`. When supplied, \`db_path\` is derived from the
  connection's underlying DuckDB file. Mutually exclusive with
  \`db_path\`.

- port:

  Port number for the R server (default: 3001)

- frontend_port:

  Port number for the frontend server (default: 5173)

- browser:

  Logical. Open browser automatically (default: TRUE)

- daemon:

  Logical. Run server in background (default: FALSE)

- host:

  Host address (default: "127.0.0.1")

- agent:

  Logical. Enable the local dbVisuals agent API for AI-assisted schema
  inspection, bounded SQL, materialization, and visualization rendering
  (default: FALSE).

- agent_token:

  Optional bearer token for the local agent API. If `agent = TRUE` and
  no token is supplied, a random token is generated.

- agent_allow_write:

  Logical. Allow the agent to create tables/views and persist
  visualization metadata (default: FALSE).

- agent_allow_r:

  Logical. Allow the agent to execute R code through the existing SQL
  Rooms R execution path (default: FALSE).

- agent_max_rows:

  Integer. Maximum rows returned by bounded agent SQL queries and
  visualization data previews (default: 1000).

## Value

Invisibly returns a list with server information.

## Examples

``` r
if (FALSE) { # \dontrun{
# Launch with in-memory database
launchBrowser()

# Launch with a specific GiottoDB database
launchBrowser(db_path = "giottodb-visium.db")

# Launch from a dbProject
proj <- dbProject::dbProject(path = "my_project", dbdir = "my.duckdb")
launchBrowser(project = proj)

# Launch from a raw DBIConnection
con <- DBI::dbConnect(duckdb::duckdb(), dbdir = "my.duckdb")
launchBrowser(project = con)

# Launch without opening browser
launchBrowser(browser = FALSE)
} # }
```
