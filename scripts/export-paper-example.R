#!/usr/bin/env Rscript
# Run from the repository root. DBLENS_* variables configure the real inputs
# for the in-situ example; the dimred example uses GiottoData's mini Visium.
args <- commandArgs(TRUE)
stopifnot(length(args) == 2L, args[[1]] %in% c("dimred", "insitu"))
label <- args[[1]]
out <- args[[2]]
dir.create(out, recursive = TRUE, showWarnings = FALSE)
out <- normalizePath(out)
options(viewer = NULL, browser = function(...) invisible(NULL))
example <- if (label == "dimred") "03_dimred_concat.R" else "06_in_situ_zoom_overlay_transcripts_interactive.R"
source(file.path("r-package", "examples", example), local = globalenv())
htmlwidgets::saveWidget(viewer, file.path(out, paste0(label, ".html")), selfcontained = FALSE)
if (label == "dimred") {
  stopifnot(nrow(cells) > 0L, all(is.finite(as.matrix(cells[, c("umap_1", "umap_2", "umap_3", "pca_1", "pca_2", "pca_3")]))))
  expected <- list(cells = nrow(cells), clusters = as.list(table(cells$leiden_clus)))
} else {
  actual <- DBI::dbGetQuery(con, transcript_query)
  stopifnot(nrow(actual) == n_transcripts, all(is.finite(actual$x)), all(is.finite(actual$y)))
  colours <- unique(centroids[, c("r", "g", "b")])
  expected <- list(centroids = nrow(centroids), transcripts = n_transcripts,
                   roi = roi, detail_roi = detail_roi, polygon_table = polygon_table,
                   annotations = unique(centroids$cluster), use_id_join = use_id_join,
                   color_by = color_by, cell_summary = if (nzchar(cell_summary)) cell_summary else NULL,
                   cell_summary_md5 = cell_summary_md5, distinct_cell_colors = nrow(colours),
                   cells_with_summary = if (color_by == "cluster") NULL else sum(is.finite(centroids$n_transcripts)),
                   roi_cell_id = focus$cell_ID[[1L]], hide_controls = hide_controls,
                   main_panel_px = main_panel_px, zoom_panel_px = zoom_panel_px, detail_panel_px = detail_panel_px)
}
jsonlite::write_json(expected, file.path(out, paste0(label, "-expected.json")), auto_unbox = TRUE, pretty = TRUE)
cat("EXPORTED", label, "with dbVisuals", as.character(packageVersion("dbVisuals")), "\n")
print(sessionInfo())
