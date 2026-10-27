# Shiny render expression for the Mosaic + deck.gl viewer

Shiny render expression for the Mosaic + deck.gl viewer

## Usage

``` r
renderMosaic_gl(expr, env = parent.frame(), quoted = FALSE)
```

## Arguments

- expr:

  An expression that returns a list.

- env:

  The parent environment for the reactive expression. By default, this
  is the calling environment, the same as when defining an ordinary
  non-reactive expression. If `expr` is a quosure and `quoted` is
  `TRUE`, then `env` is ignored.

- quoted:

  If it is `TRUE`, then the
  [`quote()`](https://rdrr.io/r/base/substitute.html)ed value of `expr`
  will be used when `expr` is evaluated. If `expr` is a quosure and you
  would like to use its expression as a value for `expr`, then you must
  set `quoted` to `TRUE`.

## Value

A Shiny render function for use with \[mosaic_glOutput()\].

## Examples

``` r
if (interactive() && requireNamespace("shiny", quietly = TRUE) &&
    requireNamespace("arrow", quietly = TRUE)) {
  pts <- data.frame(id = 1:100, x = stats::rnorm(100), y = stats::rnorm(100))
  spec <- mgl_spec(
    data = list(pts = mgl_data(type = "table", df = pts)),
    plot = list(list(mark = "dot", data = list(from = "pts"), x = "x", y = "y")))
  shiny::shinyApp(
    ui = shiny::fluidPage(mosaic_glOutput("viewer")),
    server = function(input, output) {
      output$viewer <- renderMosaic_gl(mosaic_gl(spec))
    })
}
```
