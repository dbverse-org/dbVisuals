# R/mosaic_gl.R - htmlwidget entry point for the combined Mosaic + deck.gl viewer

#' Render a linked Mosaic + deck.gl visualization
#'
#' Bundles vgplot and deck.gl into one browser scope, with a shared
#' DuckDB-WASM coordinator and `vg.Selection.crossfilter()` so that any
#' panel that brushes/toggles/lassoes contributes a clause that filters
#' every other panel.
#'
#' @param spec    A spec built with [mgl_spec()] (or a plain list with the
#'   same structure).
#' @param con     Optional DBI connection to an R-side DuckDB used to hydrate
#'   `mgl_data(type = "duckdb")` references. Pass an existing connection so
#'   spatial / nanoarrow / geoarrow extensions you've already configured are
#'   reused.
#' @param width,height  Widget dimensions.
#' @param element_id    Optional DOM id.
#' @return An htmlwidget.
#' @export
mosaic_gl <- function(spec, con = NULL, width = NULL, height = NULL, element_id = NULL) {
  if (!inherits(spec, "mgl_spec") && !is.list(spec))
    stop("'spec' must be a list (use mgl_spec() to build one).")

  # Ensure standard extensions are loaded if a connection was provided
  if (!is.null(con)) {
    for (sql in c("INSTALL spatial", "LOAD spatial",
                  "INSTALL nanoarrow FROM community", "LOAD nanoarrow",
                  "CALL register_geoarrow_extensions()"))
      try(DBI::dbExecute(con, sql), silent = TRUE)
  }

  data_envelopes <- .hydrate_data(spec, con = con)

  uid <- paste0("mosaic_gl_",
                sprintf("%08x", sample.int(.Machine$integer.max, 1L)))
  session <- if (requireNamespace("shiny", quietly = TRUE))
    shiny::getDefaultReactiveDomain() else NULL

  # In Shiny: stand up a query handler so JS can ask for additional Arrow IPC
  # blobs (e.g. follow-up queries triggered by interactions) without going
  # through the browser DuckDB.
  if (!is.null(session) && !is.null(con)) {
    .install_shiny_query_handler(session, uid, con)
  }

  widget_payload <- list(
    # Mosaic spec verbatim, minus the data block (we ship its bytes separately
    # so the spec sent over the wire stays small). The JS side hydrates dataEnv
    # into DuckDB-WASM under the same names, so spec nodes like
    # `data: { from: "cells" }` resolve automatically.
    spec      = .strip_spec_data(spec),
    dataEnv   = unname(data_envelopes),
    widgetId  = uid,
    hasShiny  = !is.null(session)
  )

  htmlwidgets::createWidget(
    name        = "mosaic_gl",
    x           = widget_payload,
    width       = width,
    height      = height,
    package     = "dbVisuals",
    elementId   = element_id,
    sizingPolicy = htmlwidgets::sizingPolicy(
      defaultWidth  = "100%",
      defaultHeight = 600,
      browser.fill  = TRUE,
      viewer.fill   = TRUE,
      knitr.figure  = FALSE
    )
  )
}

#' Shiny output binding for the Mosaic + deck.gl viewer
#' @inheritParams shiny::imageOutput
#' @export
mosaic_glOutput <- function(outputId, width = "100%", height = "600px") {
  htmlwidgets::shinyWidgetOutput(outputId, "mosaic_gl", width, height,
                                   package = "dbVisuals")
}

#' Shiny render expression for the Mosaic + deck.gl viewer
#' @inheritParams shiny::renderImage
#' @export
renderMosaic_gl <- function(expr, env = parent.frame(), quoted = FALSE) {
  if (!quoted) expr <- substitute(expr)
  htmlwidgets::shinyRenderWidget(expr, mosaic_glOutput, env, quoted = TRUE)
}

# ── internals ────────────────────────────────────────────────────────────────

# Strip the inline data.frames / SQL queries (encoded into Arrow IPC bytes in
# dataEnv) so the Mosaic spec going to JS contains no `data` block. The JS
# side registers each envelope as a DuckDB-WASM table under its declared name,
# so Mosaic spec nodes like `data: { from: "cells" }` resolve naturally.
.strip_spec_data <- function(spec) {
  out <- unclass(spec)
  out$data <- NULL
  out
}

.install_shiny_query_handler <- function(session, uid, con) {
  input_name  <- paste0(uid, "_query")
  output_name <- paste0(uid, "_response")
  if (is.null(session$userData$mosaic_glCons))
    session$userData$mosaic_glCons <- list()
  session$userData$mosaic_glCons[[uid]] <- con

  shiny::observeEvent(session$input[[input_name]], {
    req <- session$input[[input_name]]
    if (is.null(req)) return()
    sql <- req$sql
    fmt <- req$format %||% "arrow"
    tryCatch({
      if (identical(fmt, "geoarrow")) {
        env <- .encode_duckdb_geoarrow(con, sql, "_q")
      } else if (identical(fmt, "arrow")) {
        env <- .encode_duckdb_arrow(con, sql, "_q")
      } else {
        df <- DBI::dbGetQuery(con, sql)
        env <- list(encoding = "json",
                    rows = unname(lapply(seq_len(nrow(df)),
                      function(i) as.list(df[i, , drop = FALSE]))))
      }
      session$sendCustomMessage(output_name, list(
        request  = req$request,
        encoding = env$encoding,
        bytes    = env$bytes,
        rows     = env$rows
      ))
    }, error = function(e) {
      session$sendCustomMessage(output_name, list(
        request = req$request,
        error   = as.character(e$message)
      ))
    })
  }, ignoreNULL = TRUE)

  if (is.null(session$userData$.mosaic_glCleanup)) {
    session$onSessionEnded(function() {
      lapply(session$userData$mosaic_glCons,
             function(c) try(DBI::dbDisconnect(c), silent = TRUE))
    })
    session$userData$.mosaic_glCleanup <- TRUE
  }
}
