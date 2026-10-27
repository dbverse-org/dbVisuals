# Shiny output binding for the Mosaic + deck.gl viewer

Shiny output binding for the Mosaic + deck.gl viewer

## Usage

``` r
mosaic_glOutput(outputId, width = "100%", height = "600px")
```

## Arguments

- outputId:

  output variable to read the plot/image from.

- width, height:

  Image width/height. Must be a valid CSS unit (like `"100%"`,
  `"400px"`, `"auto"`) or a number, which will be coerced to a string
  and have `"px"` appended. These two arguments are ignored when
  `inline = TRUE`, in which case the width/height of a plot must be
  specified in `renderPlot()`. Note that, for height, using `"auto"` or
  `"100%"` generally will not work as expected, because of how height is
  computed with HTML/CSS.

## Value

A Shiny UI element that holds a \[mosaic_gl()\] widget.

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
