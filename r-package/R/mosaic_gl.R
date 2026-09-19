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
#'   The connection is never disconnected by this package, in a Shiny session or
#'   otherwise: the caller owns its lifetime.
#' @param width,height  Widget dimensions.
#' @param element_id    Optional DOM id.
#' @param data_transport How query-backed sources (`mgl_data(type = "duckdb")`)
#'   reach the browser. `"inline"` embeds each result set as base64 in the
#'   widget JSON; `"file"` streams it into `data_dir` and the page fetches the
#'   file by relative URL, so nothing is copied into the HTML; `"auto"` (the
#'   default) picks `"file"` when `data_dir` is given and `"inline"` otherwise.
#'   Both transports let DuckDB write the file itself (COPY ... FORMAT ARROWS
#'   when the community 'nanoarrow' extension loads, else a record-batch stream
#'   through `arrow::write_ipc_stream()`, else COPY ... FORMAT PARQUET), so the
#'   rows are never materialised in R. Each envelope records the rung used in
#'   `exportMethod`; `options(dbVisuals.export_methods = "copy_parquet")` (or
#'   any subset of `"copy_arrows"`, `"record_batch_stream"`, `"copy_parquet"`)
#'   restricts the ladder, mainly for diagnostics. `type = "table"` data frames
#'   are always embedded inline because they already live in R.
#' @param data_dir Directory that receives the exported files under
#'   `data_transport = "file"`; when omitted a session temporary directory is
#'   used. The files travel with the widget as an html dependency attachment,
#'   so the RStudio Viewer, Shiny and
#'   `htmlwidgets::saveWidget(selfcontained = FALSE)` all resolve them
#'   (`selfcontained = TRUE` is not supported for file transport).
#' @return An htmlwidget.
#' @export
mosaic_gl <- function(spec, con = NULL, width = NULL, height = NULL, element_id = NULL,
                      data_transport = c("auto", "inline", "file"), data_dir = NULL) {
  if (!inherits(spec, "mgl_spec") && !is.list(spec))
    stop("'spec' must be a list (use mgl_spec() to build one).")
  data_transport <- match.arg(data_transport)
  if (identical(data_transport, "auto"))
    data_transport <- if (is.null(data_dir)) "inline" else "file"
  if (identical(data_transport, "file")) {
    if (is.null(data_dir)) data_dir <- .mgl_session_data_dir("dbvisuals-data-")
    if (!is.character(data_dir) || length(data_dir) != 1L || !nzchar(data_dir))
      stop("data_transport = 'file' requires 'data_dir' to be a single directory path.")
    if (!dir.exists(data_dir)) dir.create(data_dir, recursive = TRUE)
    data_dir <- normalizePath(data_dir, winslash = "/", mustWork = TRUE)
  }

  # Ensure standard extensions are loaded if a connection was provided. Only
  # the spatial extension is installed on demand, because GeoArrow export
  # depends on it; nanoarrow is loaded when present and skipped otherwise.
  if (!is.null(con)) {
    for (sql in c("INSTALL spatial", "LOAD spatial", "LOAD nanoarrow",
                  "CALL register_geoarrow_extensions()"))
      try(DBI::dbExecute(con, sql), silent = TRUE)
  }

  data_envelopes <- .hydrate_data(spec, con = con,
                                  data_transport = data_transport,
                                  data_dir = data_dir)

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
    dataTransport = data_transport,
    widgetId  = uid,
    hasShiny  = !is.null(session)
  )

  # File-transport payloads travel with the widget as an html dependency
  # attachment, so the relative URL in each envelope resolves in the RStudio
  # Viewer, in Shiny and after saveWidget() into any directory.
  data_dependency <- NULL
  if (identical(data_transport, "file")) {
    urls <- unique(unlist(lapply(data_envelopes, function(e) e$url)))
    urls <- urls[!is.na(urls) & nzchar(urls)]
    urls <- urls[file.exists(file.path(data_dir, urls))]
    if (length(urls))
      data_dependency <- htmltools::htmlDependency(
        name = paste0("mosaic-gl-data-", uid),
        version = as.character(utils::packageVersion("dbVisuals")),
        src = c(file = data_dir),
        attachment = stats::setNames(urls, paste0("data", seq_along(urls))),
        all_files = FALSE
      )
  }

  htmlwidgets::createWidget(
    name        = "mosaic_gl",
    x           = widget_payload,
    width       = width,
    height      = height,
    package     = "dbVisuals",
    elementId   = element_id,
    dependencies = if (is.null(data_dependency)) NULL else list(data_dependency),
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
  # The connection is always the caller's: mosaic_gl() never opens one. It is
  # kept only so the query observer can reach it, and is never disconnected
  # here; closing it would break every later session in the same R process.
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

  # Drop the references when the session ends so they can be garbage collected,
  # but leave the connections themselves open for their owner.
  if (is.null(session$userData$.mosaic_glCleanup)) {
    session$onSessionEnded(function() {
      session$userData$mosaic_glCons <- NULL
    })
    session$userData$.mosaic_glCleanup <- TRUE
  }
}

# An auto-created data directory is scoped to the Shiny session that renders the
# widget: one directory per session instead of one per render, removed when the
# session ends. Outside Shiny it is a session temporary directory as before.
# Re-rendering a widget still writes a new payload into that directory; the
# previous one is removed with the directory when the session ends.
.mgl_session_data_dir <- function(prefix) {
  session <- if (requireNamespace("shiny", quietly = TRUE)) shiny::getDefaultReactiveDomain() else NULL
  if (is.null(session)) return(tempfile(prefix))
  existing <- session$userData$.mgl_data_dir
  if (!is.null(existing) && dir.exists(existing)) return(existing)
  path <- tempfile(prefix)
  dir.create(path, recursive = TRUE, showWarnings = FALSE)
  session$userData$.mgl_data_dir <- path
  session$onSessionEnded(function() unlink(path, recursive = TRUE))
  path
}
