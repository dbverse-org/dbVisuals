# Build a deck.gl input node for a Mosaic spec

Produces \`list(input = "deckgl", id = ..., filterBy = ..., layers =
..., concat = ..., width = ..., height = ...)\`. Drop it into a Mosaic
spec anywhere an \`input = "menu"\` would be valid.

## Usage

``` r
mgl_deckgl(
  id,
  layers,
  concat = NULL,
  filter_by = NULL,
  tools = c("pan", "lasso", "+lasso", "clear", "fit"),
  title = NULL,
  width = NULL,
  height = NULL,
  ...
)
```

## Arguments

- id:

  Required identifier (used for cleanup + lasso source tag).

- layers:

  List of deck.gl layer specs (\`@type\`, \`data\`, accessors). Layer
  \`data\` is a string referencing a name from \`mgl_spec(data = ...)\`.

- concat:

  Optional concat config: \`list(orient = "hconcat", panes = list(list(x
  = "umap_1", y = "umap_2"), ...))\`. Each pane reuses the same
  \`layers\` but with the position accessor swapped to (pane\$x,
  pane\$y) — used for the UMAP / PCA dim-pair grid.

- filter_by:

  A Mosaic param reference (character \`"\$sel"\`) or a pre-built
  Selection. The deck.gl panel subscribes to it and re-renders when its
  clauses change.

- tools:

  Toolbar buttons. Defaults to \`c("pan", "lasso", "+lasso", "clear",
  "fit")\`. \`"lasso"\` replaces the previous lasso clause, \`"+lasso"\`
  unions the new lasso with the previous one, and \`"clear"\` removes
  this deck.gl panel's lasso clause.

- title:

  Optional title shown above the canvas.

- width, height:

  CSS dimensions for the panel (number → px).

- ...:

  Further options passed verbatim (e.g. \`initialViewState\`).

## Value

A list describing the panel, for use inside \[mgl_spec()\].

## Examples

``` r
panel <- mgl_deckgl(
  id = "map", filter_by = "$sel", width = 400, height = 300,
  layers = list(list(`@@type` = "ScatterplotLayer", id = "pts", data = "pts",
                     getPosition = "@@=[x, y]", getRadius = 2,
                     radiusUnits = "pixels")))
panel$input
#> [1] "deckgl"
```
