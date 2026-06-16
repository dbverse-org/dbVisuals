# Install Complete dbVisuals Dependencies

Installs all recommended dependencies for dbVisuals to enable full SQL
Rooms functionality. This installs database packages (DBI, duckdb) from
CRAN, and the optional visualization packages (rDeckgl, rMosaic) from
GitHub.

## Usage

``` r
install_dbvisuals_deps(ask = interactive())
```

## Arguments

- ask:

  Logical. Ask the user for confirmation before installing in
  interactive sessions. Defaults to \`interactive()\`, so
  non-interactive sessions must pass \`ask = FALSE\` explicitly to
  proceed.

## Value

Invisibly returns \`TRUE\` if all installations succeeded, \`FALSE\`
otherwise (e.g., user declined, \`remotes\` not available,
non-interactive).

## Details

This function installs:

- CRAN packages: DBI, duckdb

- GitHub packages: rDeckgl, rMosaic (from TiRizvanov)

The function checks which packages are already installed and only
installs missing ones. Requires the 'remotes' package for GitHub
installations. In interactive sessions the user is asked to confirm
before any installation starts; in non-interactive sessions the function
aborts with a message.

## Examples

``` r
if (FALSE) { # \dontrun{
# Install all recommended dependencies after confirming the prompt
install_dbvisuals_deps()

# Skip the prompt (e.g. inside an automated environment)
install_dbvisuals_deps(ask = FALSE)
} # }
```
