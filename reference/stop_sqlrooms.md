# Stop SQL Rooms Processes

Stops SQL Rooms background processes started by \[launchBrowser()\].
This helper stops both the R execution server and the frontend server.

## Usage

``` r
stop_sqlrooms(dashboard = NULL)
```

## Arguments

- dashboard:

  Optional list returned by \[launchBrowser()\]. If NULL, stops the most
  recent SQL Rooms processes tracked in the package environment.

## Value

Invisibly returns a list with logical flags: `r_server_stopped`,
`frontend_stopped`.

## Examples

``` r
if (FALSE) { # \dontrun{
result <- launchBrowser(browser = FALSE)
stop_sqlrooms(result)
} # }
```
