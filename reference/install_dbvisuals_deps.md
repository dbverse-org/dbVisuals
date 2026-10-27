# Install Complete dbVisuals Dependencies

Installs all recommended dependencies for dbVisuals to enable full SQL
Rooms functionality. Everything comes from CRAN: the database packages
(DBI, duckdb) and the visualization backends (rDeckgl, rMosaic).

## Usage

``` r
install_dbvisuals_deps(ask = TRUE)
```

## Arguments

- ask:

  Logical. Ask the user for confirmation before installing. Defaults to
  \`TRUE\`: interactive sessions are prompted, and non-interactive
  sessions install nothing unless the caller passes \`ask = FALSE\`
  explicitly.

## Value

Invisibly returns \`TRUE\` if all installations succeeded, \`FALSE\`
otherwise (e.g., the user declined, or a non-interactive session).

## Details

This function installs, all from CRAN:

- DBI, duckdb

- rDeckgl, rMosaic

The function checks which packages are already installed and only
installs missing ones. In interactive sessions the user is asked to
confirm before any installation starts; in non-interactive sessions the
function aborts with a message.

## Examples

``` r
if (FALSE) { # \dontrun{
# Install all recommended dependencies after confirming the prompt
install_dbvisuals_deps()

# Skip the prompt (e.g. inside an automated environment)
install_dbvisuals_deps(ask = FALSE)
} # }
```
