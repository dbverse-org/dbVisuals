# R/spec.R - thin helpers around the native Mosaic spec format.
#
# A viewer spec is a regular R list shaped EXACTLY like a Mosaic JSON/YAML spec
# (the same one taxi-crossfilter, gaia-stars, and protein-design-explorer use).
# The only addition is one custom input type:
#
#   list(input = "deckgl", id = "main", layers = list(...), filterBy = "$sel")
#
# The JS side registers "deckgl" as a Mosaic input via `parseSpec(..., inputs)`
# + `api.deckgl = function(opts){...}`, so this node renders as a deck.gl Deck
# embedded in the same Mosaic concat layout as the surrounding plots / menus /
# tables, wired to the same vg.Selection.
#
# You can write specs directly as nested lists (see examples/). These helpers
# are convenience constructors for the common bits.

#' Construct a top-level Mosaic spec for the viewer
#'
#' Accepts the same shape as Mosaic / rMosaic:
#'   meta, data, params, vconcat / hconcat / plot / input ...
#'
#' Pass each top-level field as a named argument and they will be packaged into
#' a list. To author specs ergonomically just build a regular R list.
#' @param ... Named top-level fields of a Mosaic spec.
#' @return A list with class `"mgl_spec"`.
#' @export
mgl_spec <- function(...) {
  spec <- list(...)
  structure(spec, class = "mgl_spec")
}

#' Declare a data source for a viewer spec
#'
#' Two transport modes:
#'   * `type = "table"` (default) — a data.frame from R, serialized as Arrow
#'      IPC and registered in DuckDB-WASM under its name. Mosaic / deck.gl
#'      panels reference it by that name.
#'   * `type = "duckdb"` — a SQL query against the R-side DuckDB connection.
#'      Result is streamed as Arrow IPC (or GeoArrow IPC when
#'      `format = "geoarrow"`).
#' @param type   `"table"` for an in-memory data.frame or `"duckdb"` for a SQL
#'   query against the `con` passed to [mosaic_gl()].
#' @param df     Data frame used when `type = "table"`.
#' @param query  SQL query used when `type = "duckdb"`.
#' @param format Transport format for DuckDB queries. `"geoarrow"` will use a
#'   WKB polygon envelope for `cell_ID` + `geometry` result sets and otherwise
#'   falls back to Arrow IPC.
#' @export
mgl_data <- function(type   = c("table", "duckdb"),
                      df     = NULL,
                      query  = NULL,
                      format = c("arrow", "geoarrow", "json")) {
  type <- match.arg(type)
  if (type == "table") {
    if (!is.data.frame(df))
      stop("type='table' requires 'df' to be a data.frame")
    list(type = "table", df = df)
  } else {
    if (!is.character(query) || length(query) != 1L || !nzchar(query))
      stop("type='duckdb' requires a non-empty 'query'")
    list(type = "duckdb", query = query, format = match.arg(format))
  }
}

#' Build a deck.gl input node for a Mosaic spec
#'
#' Produces `list(input = "deckgl", id = ..., filterBy = ..., layers = ...,
#' concat = ..., width = ..., height = ...)`. Drop it into a Mosaic spec
#' anywhere an `input = "menu"` would be valid.
#'
#' @param id          Required identifier (used for cleanup + lasso source tag).
#' @param layers      List of deck.gl layer specs (`@@type`, `data`, accessors).
#'   Layer `data` is a string referencing a name from `mgl_spec(data = ...)`.
#' @param concat      Optional concat config:
#'   `list(orient = "hconcat", panes = list(list(x = "umap_1", y = "umap_2"), ...))`.
#'   Each pane reuses the same `layers` but with the position accessor swapped
#'   to (pane$x, pane$y) — used for the UMAP / PCA dim-pair grid.
#' @param filter_by   A Mosaic param reference (character `"$sel"`) or a
#'   pre-built Selection. The deck.gl panel subscribes to it and re-renders
#'   when its clauses change.
#' @param tools       Toolbar buttons. Defaults to
#'   `c("pan", "lasso", "+lasso", "clear", "fit")`. `"lasso"` replaces the
#'   previous lasso clause, `"+lasso"` unions the new lasso with the previous
#'   one, and `"clear"` removes this deck.gl panel's lasso clause.
#' @param title       Optional title shown above the canvas.
#' @param width,height  CSS dimensions for the panel (number → px).
#' @param ...         Further options passed verbatim (e.g. `initialViewState`).
#' @export
mgl_deckgl <- function(id,
                        layers,
                        concat    = NULL,
                        filter_by = NULL,
                        tools     = c("pan", "lasso", "+lasso", "clear", "fit"),
                        title     = NULL,
                        width     = NULL,
                        height    = NULL,
                        ...) {
  node <- list(
    input    = "deckgl",
    id       = id,
    layers   = layers,
    concat   = concat,
    filterBy = filter_by,
    tools    = tools,
    title    = title,
    width    = width,
    height   = height
  )
  extra <- list(...)
  node <- c(node, extra)
  node[!vapply(node, is.null, logical(1L))]
}
