# dbVisuals demo 6 - interactive ROI zoom inset with transcripts.
#
# This recreates examples/02_in_situ_zoom_overlay.R, but keeps the full-tissue
# panel unchanged except for larger centroid dots. Real transcript dots are
# transported and rendered only for the selected ROI shown in the zoom inset.
#
# This example launches a Shiny-backed widget when run interactively. The select
# button works like example 02, but each drag sends one fresh transcript query to
# R and refreshes both inset views from the same returned ROI transcript rows.
# The detail button lets the user choose the secondary ROI inside the ROI inset
# without another server query.
#
# Visual design matches the publication figure in paper/outputs/examples:
#   - White background
#   - Red rectangle marks the ROI on the full-tissue panel
#   - Red connecting lines run from the ROI to the zoom inset
#   - A second detail inset is generated from a subregion of the selected ROI,
#     so the paper-style figure does not need to be composited by hand
#   - The insets overlay cell polygons, enlarged centroids, and transcript dots.
#     Transcript radius is exactly one fifth of the zoom centroid radius.

suppressPackageStartupMessages({
  library(DBI)
  library(duckdb)
  library(dbVisuals)
  library(shiny)
})

# -- 1. DB connection (same as 01) ---------------------------------------------
# Point DBLENS_DEMO_DB at your database; the fallback is a file of that name in
# the working directory, so the script carries no machine-specific path.
db_path <- Sys.getenv(
  "DBLENS_DEMO_DB",
  unset = "WTA_Preview_FFPE_Breast_Cancer_xenium.duckdb"
)
if (!file.exists(db_path)) {
  stop("Demo DB not found at '", db_path,
       "'. Set DBLENS_DEMO_DB or edit db_path at the top of this script.")
}
db_path <- normalizePath(db_path, mustWork = TRUE)
con <- dbConnect(duckdb(), dbdir = db_path, read_only = TRUE)

for (sql in c(
  "INSTALL spatial", "LOAD spatial",
  "INSTALL nanoarrow FROM community", "LOAD nanoarrow",
  "CALL register_geoarrow_extensions()"
)) try(dbExecute(con, sql), silent = TRUE)

qi <- function(x) as.character(DBI::dbQuoteIdentifier(con, x))
first_col <- function(columns, candidates) {
  hit <- columns[match(tolower(candidates), tolower(columns), nomatch = 0L)]
  hit <- hit[nzchar(hit)]
  if (length(hit)) hit[[1L]] else NULL
}
numeric_env <- function(name, default) {
  out <- suppressWarnings(as.numeric(Sys.getenv(name, unset = as.character(default))))
  if (!is.finite(out) || out <= 0) {
    stop(name, " must be a positive number.")
  }
  out
}
fraction_env <- function(name, default) {
  out <- suppressWarnings(as.numeric(Sys.getenv(name, unset = as.character(default))))
  if (!is.finite(out) || out <= 0 || out >= 1) {
    stop(name, " must be a number greater than 0 and less than 1.")
  }
  out
}

# -- 2. Data pipeline (identical to 01) ----------------------------------------
polygon_table <- {
  candidates <- c("gdb_poly_cell", "gdb_poly_z0", "gdb_poly_z1")
  matches <- intersect(candidates, DBI::dbListTables(con))
  if (length(matches) < 1) {
    stop("Demo DB must contain one of: ", paste(candidates, collapse = ", "))
  }
  matches[[1]]
}
polygon_ident <- as.character(DBI::dbQuoteIdentifier(con, polygon_table))

geom_type <- dbGetQuery(con, sprintf(
  "SELECT data_type FROM information_schema.columns
     WHERE table_name = '%s' AND column_name = 'geom'",
  polygon_table))
geom_is_geometry <- nrow(geom_type) > 0 &&
  grepl("GEOMETRY", toupper(as.character(geom_type$data_type[1])))
geom_expr <- if (geom_is_geometry) "geom" else "ST_GeomFromWKB(geom)"

y_bounds <- dbGetQuery(con, sprintf(
  "SELECT MIN(ST_YMin(%s)) AS ymin, MAX(ST_YMax(%s)) AS ymax FROM %s",
  geom_expr, geom_expr, polygon_ident))
y_offset <- y_bounds$ymin[[1]] + y_bounds$ymax[[1]]
geom_flipped_sql <- sprintf("ST_Translate(ST_Scale(%s, 1, -1), 0, %f)",
                             geom_expr, y_offset)

centroids <- dbGetQuery(con, sprintf(
  "SELECT poly_ID AS cell_ID,
          ST_X(ST_Centroid(%s)) AS x,
          %f - ST_Y(ST_Centroid(%s)) AS y,
          ST_Area(%s) AS area
   FROM %s
   WHERE %s IS NOT NULL AND NOT ST_IsEmpty(%s)",
  geom_expr, y_offset, geom_expr, geom_expr,
  polygon_ident, geom_expr, geom_expr))

db_tables <- DBI::dbListTables(con)
rna_table <- switch(
  polygon_table,
  gdb_poly_z0        = if ("gdb_z0_rna_raw"        %in% db_tables)
    "gdb_z0_rna_raw"        else NULL,
  gdb_poly_z1        = if ("gdb_z1_rna_raw"        %in% db_tables)
    "gdb_z1_rna_raw"        else NULL,
  gdb_poly_aggregate = if ("gdb_aggregate_rna_raw" %in% db_tables)
    "gdb_aggregate_rna_raw" else NULL,
  NULL
)

if (!is.null(rna_table) && "features" %in% db_tables) {
  rna_ident <- as.character(DBI::dbQuoteIdentifier(con, rna_table))
  cell_stats <- dbGetQuery(con, sprintf(
    "WITH polys AS (
       SELECT row_number() OVER () AS j, poly_ID AS cell_ID FROM %s
     ),
     feats AS (
       SELECT row_number() OVER () AS i, feat_ID FROM features
     ),
     gene_cell AS (
       SELECT p.cell_ID, f.feat_ID, SUM(r.x) AS expr
       FROM %s AS r
       JOIN polys AS p USING (j)
       JOIN feats AS f USING (i)
       GROUP BY 1, 2
     ),
     dominant AS (
       SELECT cell_ID, feat_ID AS cluster
       FROM (
         SELECT cell_ID, feat_ID, expr,
                row_number() OVER (
                  PARTITION BY cell_ID ORDER BY expr DESC, feat_ID
                ) AS rn
         FROM gene_cell
       ) WHERE rn = 1
     )
     SELECT s.cell_ID, s.total_expr, s.nr_feats,
            COALESCE(d.cluster, 'unassigned') AS cluster
     FROM (
       SELECT cell_ID, SUM(expr) AS total_expr, COUNT(*) AS nr_feats
       FROM gene_cell GROUP BY 1
     ) AS s LEFT JOIN dominant AS d USING (cell_ID)",
    polygon_ident, rna_ident
  ))
  centroids <- merge(
    centroids, cell_stats, by = "cell_ID", all.x = TRUE, sort = FALSE
  )
  centroids$total_expr[is.na(centroids$total_expr)] <- 0
  centroids$nr_feats[is.na(centroids$nr_feats)]     <- 0
  centroids$cluster[is.na(centroids$cluster)]       <- "unassigned"
} else {
  # Missing biological annotations are unknown, not simulated measurements.
  centroids$total_expr <- NA_real_
  centroids$nr_feats   <- NA_real_
  centroids$cluster    <- "unannotated"
  message("No keyed expression annotations available; using unannotated cell styling.")
}

# -- Colour scale ---------------------------------------------------------------
# DBLENS_CELL_SUMMARY names a parquet with cell_id and n_transcripts aggregated
# once from the public transcript table with the same qv/is_gene filters used
# below (paper/scripts/build_atera_cell_summary.R). Cells are then coloured by
# log10 transcripts per cell on a viridis ramp, clipped at the 2nd and 98th
# percentiles; cells absent from the summary stay grey. Without a summary the
# categorical palette over `cluster` is kept.
cell_summary <- Sys.getenv("DBLENS_CELL_SUMMARY", unset = "")
color_by <- "cluster"
cell_summary_md5 <- NA_character_
if (nzchar(cell_summary)) {
  cell_summary <- normalizePath(cell_summary, mustWork = TRUE)
  cell_summary_md5 <- unname(tools::md5sum(cell_summary))
  counts <- dbGetQuery(con, sprintf(
    "SELECT cell_id AS cell_ID, n_transcripts FROM read_parquet(%s)",
    as.character(DBI::dbQuoteString(con, cell_summary))))
  centroids <- merge(centroids, counts, by = "cell_ID", all.x = TRUE, sort = FALSE)
  color_by <- "log10 transcripts per cell"
  known <- is.finite(centroids$n_transcripts) & centroids$n_transcripts > 0
  log_counts <- log10(centroids$n_transcripts[known])
  scale_range <- stats::quantile(log_counts, c(0.02, 0.98), names = FALSE)
  ramp <- grDevices::col2rgb(grDevices::hcl.colors(256, "viridis"))
  ramp_index <- 1L + as.integer(round(255 * pmin(1, pmax(0,
    (log_counts - scale_range[[1]]) / diff(scale_range)))))
  centroids$r <- 190L; centroids$g <- 190L; centroids$b <- 190L
  centroids$r[known] <- as.integer(ramp[1, ramp_index])
  centroids$g[known] <- as.integer(ramp[2, ramp_index])
  centroids$b[known] <- as.integer(ramp[3, ramp_index])
  message(sprintf("Colouring %d of %d cells by log10 transcripts per cell (%.2f to %.2f)",
                  sum(known), nrow(centroids), scale_range[[1]], scale_range[[2]]))
} else {
  pal  <- grDevices::hcl.colors(length(unique(centroids$cluster)), "Dark 3")
  rgb_ <- grDevices::col2rgb(pal[as.integer(factor(centroids$cluster))])
  centroids$r <- as.integer(rgb_[1, ])
  centroids$g <- as.integer(rgb_[2, ])
  centroids$b <- as.integer(rgb_[3, ])
}

# A centroid sits inside a polygon of its own colour, so an identically coloured
# dot is invisible and a white or black one throws the colour away. Each centroid
# keeps its cell's hue and gets a lightness, set in CIELAB, that stands apart from
# the polygon beneath it; scaling RGB instead sent the lower half of the viridis
# ramp to near-black. Chroma is held at a readable minimum and lowered only as far
# as sRGB requires. The overview draws polygons opaque, so its dots step 22 L*
# away from the cell (lighter for dark cells); the insets fade their polygons
# towards white, so there the dots are a mid-tone darker than the faded fill.
centroid_shade <- function(rgb, lightness) {
  lab <- grDevices::convertColor(rgb / 255, from = "sRGB", to = "Lab")
  hue <- atan2(lab[, 3], lab[, 2])
  chroma <- sqrt(lab[, 2]^2 + lab[, 3]^2)
  chroma <- ifelse(chroma < 5, chroma, pmax(chroma, 40))
  L <- lightness(lab[, 1])
  repeat {
    shade <- grDevices::convertColor(cbind(L, chroma * cos(hue), chroma * sin(hue)),
                                     from = "Lab", to = "sRGB", clip = NA)
    outside <- !stats::complete.cases(shade)
    if (!any(outside)) break
    chroma[outside] <- chroma[outside] * 0.95
  }
  matrix(as.integer(round(shade * 255)), ncol = 3)
}
cell_rgb <- cbind(centroids$r, centroids$g, centroids$b)
overview_shade <- centroid_shade(cell_rgb, function(L) ifelse(L >= 55, L - 22, L + 22))
inset_shade <- centroid_shade(cell_rgb, function(L) pmin(62, pmax(50, L - 8)))
centroids$ov_r <- overview_shade[, 1]; centroids$ov_g <- overview_shade[, 2]; centroids$ov_b <- overview_shade[, 3]
centroids$dr <- inset_shade[, 1]; centroids$dg <- inset_shade[, 2]; centroids$db <- inset_shade[, 3]

# Polygons carry the same per-cell colour as their centroid so the fill can be
# read from the geometry envelope's properties in every panel.
dbWriteTable(con, "mgl_cell_colors", centroids[, c("cell_ID", "r", "g", "b")],
             temporary = TRUE, overwrite = TRUE)
polygon_query <- sprintf(
  "SELECT p.poly_ID AS cell_ID,
          %s AS geometry,
          COALESCE(c.r, 190) AS r, COALESCE(c.g, 190) AS g, COALESCE(c.b, 190) AS b
   FROM %s AS p
   LEFT JOIN mgl_cell_colors AS c ON c.cell_ID = p.poly_ID
   WHERE %s IS NOT NULL AND NOT ST_IsEmpty(%s) AND ST_NPoints(%s) >= 4",
  gsub("\\bgeom\\b", "p.geom", geom_flipped_sql),
  polygon_ident,
  gsub("\\bgeom\\b", "p.geom", geom_expr),
  gsub("\\bgeom\\b", "p.geom", geom_expr),
  gsub("\\bgeom\\b", "p.geom", geom_expr))

# -- 3. Static ROI for the zoom inset ------------------------------------------
ext <- list(
  xmin = min(centroids$x), xmax = max(centroids$x),
  ymin = min(centroids$y), ymax = max(centroids$y)
)
cx     <- 0.5 * (ext$xmin + ext$xmax)
cy     <- 0.5 * (ext$ymin + ext$ymax)

focus_cell_id <- Sys.getenv("DBLENS_ROI_CELL_ID", unset = "")
if (nzchar(focus_cell_id)) {
  focus <- centroids[centroids$cell_ID == focus_cell_id, , drop = FALSE]
  if (!nrow(focus)) stop("DBLENS_ROI_CELL_ID was not found: ", focus_cell_id)
  focus <- focus[1L, , drop = FALSE]
} else {
  d2 <- (centroids$x - cx)^2 + (centroids$y - cy)^2
  focus <- centroids[which.min(d2), , drop = FALSE]
}

roi_half_width <- numeric_env("DBLENS_ROI_HALF_WIDTH", 120)
half_w <- roi_half_width
half_h <- roi_half_width
roi <- list(
  xmin = focus$x[[1L]] - half_w, xmax = focus$x[[1L]] + half_w,
  ymin = focus$y[[1L]] - half_h, ymax = focus$y[[1L]] + half_h
)

# The ROI is defined in display coordinates. Convert its Y range back to the
# raw polygon coordinate system for spatial intersection against `geom`.
roi_raw_ymin <- min(y_offset - roi$ymin, y_offset - roi$ymax)
roi_raw_ymax <- max(y_offset - roi$ymin, y_offset - roi$ymax)
dbExecute(con, sprintf(
  "CREATE OR REPLACE TEMP TABLE mgl_roi_cells AS
   SELECT p.poly_ID AS cell_ID
   FROM %s AS p
   WHERE %s IS NOT NULL AND NOT ST_IsEmpty(%s)
     AND ST_Intersects(
       %s,
       ST_MakeEnvelope(%f, %f, %f, %f)
     )",
  polygon_ident,
  gsub("\\bgeom\\b", "p.geom", geom_expr),
  gsub("\\bgeom\\b", "p.geom", geom_expr),
  gsub("\\bgeom\\b", "p.geom", geom_expr),
  roi$xmin, roi_raw_ymin, roi$xmax, roi_raw_ymax
))

# -- 4. Transcript coordinates for the zoom inset only -------------------------
local_transcript_files <- c(
  file.path(getwd(), "transcripts.parquet"),
  file.path(dirname(db_path), "transcripts.parquet")
)
local_transcript_file <- local_transcript_files[file.exists(local_transcript_files)][1L]
if (is.na(local_transcript_file)) local_transcript_file <- local_transcript_files[[1L]]
transcript_file <- Sys.getenv("DBLENS_TRANSCRIPT_FILE", unset = local_transcript_file)
transcript_table <- Sys.getenv("DBLENS_TRANSCRIPT_TABLE", unset = "")

if (file.exists(transcript_file)) {
  transcript_file <- normalizePath(transcript_file, mustWork = TRUE)
  file_arg <- as.character(DBI::dbQuoteString(con, transcript_file))
  reader <- if (grepl("\\.parquet$", transcript_file, ignore.case = TRUE)) {
    sprintf("read_parquet(%s)", file_arg)
  } else {
    sprintf("read_csv_auto(%s)", file_arg)
  }
  dbExecute(con, sprintf(
    "CREATE OR REPLACE TEMP VIEW mgl_transcript_source AS SELECT * FROM %s",
    reader
  ))
  transcript_relation <- qi("mgl_transcript_source")
  message("Using transcript coordinates from ", transcript_file)
} else {
  point_candidates <- c(
    transcript_table,
    "transcripts", "transcript_points", "gdb_points_rna", "gdb_points_cell"
  )
  point_candidates <- point_candidates[nzchar(point_candidates)]
  point_table <- point_candidates[point_candidates %in% db_tables][1L]
  if (is.na(point_table)) {
    stop(
      "No transcript coordinate source is available. Put transcripts.parquet ",
      "at the package root, set DBLENS_TRANSCRIPT_FILE, or set ",
      "DBLENS_TRANSCRIPT_TABLE to a DuckDB table with transcript x/y positions."
    )
  }
  transcript_relation <- qi(point_table)
  message("Using transcript coordinates from DuckDB table ", point_table)
}

source_columns <- names(dbGetQuery(
  con, sprintf("SELECT * FROM %s LIMIT 0", transcript_relation)
))
x_col <- first_col(source_columns, c("x_location", "x", "sdimx"))
y_col <- first_col(source_columns, c("y_location", "y", "sdimy"))
gene_col <- first_col(source_columns, c("feature_name", "feat_ID", "gene", "gene_name"))
cell_col <- first_col(source_columns, c("cell_id", "cell_ID", "poly_ID"))
id_col <- first_col(source_columns, c("transcript_id", "feat_ID_uniq", "point_id", "id"))
qv_col <- first_col(source_columns, c("qv", "quality_value"))
is_gene_col <- first_col(source_columns, c("is_gene"))
if (is.null(x_col) || is.null(y_col)) {
  stop("Transcript source requires x/y columns such as x_location and y_location.")
}

x_expr <- sprintf("TRY_CAST(%s AS DOUBLE)", qi(x_col))
y_expr <- sprintf("TRY_CAST(%s AS DOUBLE)", qi(y_col))
gene_expr <- if (is.null(gene_col)) {
  "'transcript'"
} else {
  sprintf("CAST(%s AS VARCHAR)", qi(gene_col))
}
cell_expr <- if (is.null(cell_col)) {
  "NULL::VARCHAR"
} else {
  sprintf("CAST(%s AS VARCHAR)", qi(cell_col))
}
id_expr <- if (is.null(id_col)) {
  "CAST(row_number() OVER () AS VARCHAR)"
} else {
  sprintf("CAST(%s AS VARCHAR)", qi(id_col))
}
min_qv <- numeric_env("DBLENS_MIN_QV", 20)
qv_predicate <- if (is.null(qv_col)) {
  ""
} else {
  sprintf(" AND TRY_CAST(%s AS DOUBLE) >= %f", qi(qv_col), min_qv)
}
gene_predicate <- if (is.null(is_gene_col)) {
  ""
} else {
  sprintf(" AND COALESCE(TRY_CAST(%s AS BOOLEAN), FALSE)", qi(is_gene_col))
}

sample_y <- dbGetQuery(con, sprintf(
  "SELECT %s AS y FROM %s WHERE %s IS NOT NULL LIMIT 1",
  y_expr, transcript_relation, y_expr
))$y[[1L]]
y_sign <- if (y_bounds$ymax[[1L]] <= 0 && sample_y >= 0) -1 else 1
if (y_sign < 0) {
  message("Applying Xenium-to-GiottoDB Y inversion for transcript positions.")
}
raw_y_expr <- sprintf("(%d * (%s))", y_sign, y_expr)
plot_y_expr <- sprintf("(%f - (%s))", y_offset, raw_y_expr)

# The inset shows every cell whose polygon meets the ROI, and those cells extend
# past the ROI box; the view is also fitted with a margin, so it displays more
# than the box itself. Fetching transcripts for the box alone therefore leaves
# visible cells empty at the edges. The window is the extent of the ROI cells,
# widened by the same margin the view uses, so everything on screen is filled.
roi_cell_extent <- dbGetQuery(con, sprintf(
  "SELECT MIN(ST_XMin(%1$s)) AS xmin, MAX(ST_XMax(%1$s)) AS xmax,
          MIN(%2$f - ST_YMax(%1$s)) AS ymin, MAX(%2$f - ST_YMin(%1$s)) AS ymax
   FROM %3$s AS p
   JOIN mgl_roi_cells AS c ON c.cell_ID = p.poly_ID
   WHERE %1$s IS NOT NULL AND NOT ST_IsEmpty(%1$s)",
  gsub("\\bgeom\\b", "p.geom", geom_expr), y_offset, polygon_ident))
view_margin <- 0.10
transcript_window <- list(
  xmin = min(roi$xmin, roi_cell_extent$xmin[[1L]]) - view_margin * (roi$xmax - roi$xmin),
  xmax = max(roi$xmax, roi_cell_extent$xmax[[1L]]) + view_margin * (roi$xmax - roi$xmin),
  ymin = min(roi$ymin, roi_cell_extent$ymin[[1L]]) - view_margin * (roi$ymax - roi$ymin),
  ymax = max(roi$ymax, roi_cell_extent$ymax[[1L]]) + view_margin * (roi$ymax - roi$ymin)
)
message(sprintf(
  "Transcript window %.1f x %.1f units covers the ROI (%.1f x %.1f) and every cell it touches.",
  transcript_window$xmax - transcript_window$xmin, transcript_window$ymax - transcript_window$ymin,
  roi$xmax - roi$xmin, roi$ymax - roi$ymin))

dbExecute(con, sprintf(
  "CREATE OR REPLACE TEMP TABLE mgl_roi_transcripts AS
   SELECT %1$s AS transcript_ID,
          %2$s AS source_cell_ID,
          COALESCE(%3$s, 'unknown') AS feature_name,
          %4$s AS x,
          %5$s AS y
   FROM %6$s
   WHERE %4$s BETWEEN %7$f AND %8$f
     AND %5$s BETWEEN %9$f AND %10$f
     AND %4$s IS NOT NULL AND %5$s IS NOT NULL%11$s%12$s",
  id_expr, cell_expr, gene_expr, x_expr, plot_y_expr, transcript_relation,
  transcript_window$xmin, transcript_window$xmax,
  transcript_window$ymin, transcript_window$ymax, qv_predicate, gene_predicate
))

use_id_join <- !is.null(cell_col)
if (use_id_join) {
  n_id_matches <- dbGetQuery(con, paste(
    "SELECT COUNT(*) AS n FROM mgl_roi_transcripts AS t",
    "JOIN mgl_roi_cells AS c ON t.source_cell_ID = c.cell_ID"
  ))$n[[1L]]
  use_id_join <- n_id_matches > 0
}
if (use_id_join) {
  dbExecute(con, paste(
    "CREATE OR REPLACE TEMP TABLE mgl_zoom_transcripts AS",
    "SELECT t.transcript_ID, c.cell_ID, t.feature_name, t.x, t.y",
    "FROM mgl_roi_transcripts AS t",
    "JOIN mgl_roi_cells AS c ON t.source_cell_ID = c.cell_ID"
  ))
} else {
  warning(
    "Transcript source has no cell identifiers matching polygons; using ",
    "coordinate-only ROI filtering."
  )
  dbExecute(con, paste(
    "CREATE OR REPLACE TEMP TABLE mgl_zoom_transcripts AS",
    "SELECT transcript_ID, source_cell_ID AS cell_ID, feature_name, x, y",
    "FROM mgl_roi_transcripts"
  ))
}

n_transcripts <- dbGetQuery(
  con, "SELECT COUNT(*) AS n FROM mgl_zoom_transcripts"
)$n[[1L]]
if (n_transcripts < 1) {
  stop("The selected ROI contains no within-cell transcripts after filtering.")
}
max_transcripts <- numeric_env("DBLENS_MAX_TRANSCRIPTS", 250000)
if (n_transcripts > max_transcripts) {
  stop(
    "ROI contains ", format(n_transcripts, big.mark = ","),
    " transcripts; DBLENS_MAX_TRANSCRIPTS is ", format(max_transcripts, big.mark = ","),
    ". Reduce DBLENS_ROI_HALF_WIDTH or explicitly raise the limit."
  )
}
message(
  "Zoom ROI contains ",
  format(n_transcripts, big.mark = ","),
  " transcript dots."
)

pal_tx <- grDevices::hcl.colors(256, "Dark 3")
rgb_tx <- grDevices::col2rgb(pal_tx)
transcript_palette <- data.frame(
  palette_id = seq_along(pal_tx),
  tx_r = as.integer(rgb_tx[1, ]),
  tx_g = as.integer(rgb_tx[2, ]),
  tx_b = as.integer(rgb_tx[3, ]),
  stringsAsFactors = FALSE
)
dbWriteTable(con, "mgl_transcript_palette", transcript_palette,
             temporary = TRUE, overwrite = TRUE)

# Select only what the transcript layers actually render. They are
# pickable = FALSE and read x/y plus tx_r/g/b/a; transcript_ID, cell_ID and
# feature_name were being shipped to the browser and never used, and being
# strings they dominated the JSON payload (37.1 MB -> 17.5 MB without them).
transcript_query <- paste(
  "SELECT t.x, t.y,",
  "       p.tx_r, p.tx_g, p.tx_b,",
  "       210 AS tx_a",
  "FROM mgl_zoom_transcripts AS t",
  "LEFT JOIN mgl_transcript_palette AS p",
  "  ON p.palette_id = CAST(hash(t.feature_name) % 256 AS INTEGER) + 1"
)

dynamic_from <- if (use_id_join) {
  paste(
    "FROM roi_transcripts AS t",
    "JOIN roi_cells AS c ON t.source_cell_ID = c.cell_ID"
  )
} else {
  "FROM roi_transcripts AS t"
}
transcript_query_template <- paste(
  sprintf(
    "WITH roi_cells AS (
       SELECT p.poly_ID AS cell_ID
       FROM %s AS p
       WHERE %s IS NOT NULL AND NOT ST_IsEmpty(%s)
         AND ST_Intersects(
           %s,
           ST_MakeEnvelope(__XMIN__, __RAW_YMIN__, __XMAX__, __RAW_YMAX__)
         )
     ),",
    polygon_ident,
    gsub("\\bgeom\\b", "p.geom", geom_expr),
    gsub("\\bgeom\\b", "p.geom", geom_expr),
    gsub("\\bgeom\\b", "p.geom", geom_expr)
  ),
  sprintf(
    "roi_transcripts AS (
       SELECT %1$s AS transcript_ID,
              %2$s AS source_cell_ID,
              COALESCE(%3$s, 'unknown') AS feature_name,
              %4$s AS x,
              %5$s AS y
       FROM %6$s
       WHERE %4$s BETWEEN __XMIN__ AND __XMAX__
         AND %5$s BETWEEN __YMIN__ AND __YMAX__
         AND %4$s IS NOT NULL AND %5$s IS NOT NULL%7$s%8$s
     )",
    id_expr, cell_expr, gene_expr, x_expr, plot_y_expr, transcript_relation,
    qv_predicate, gene_predicate
  ),
  # Same reasoning as transcript_query above: render-used columns only.
  "SELECT t.x, t.y,",
  "       p.tx_r, p.tx_g, p.tx_b,",
  "       210 AS tx_a",
  dynamic_from,
  "LEFT JOIN mgl_transcript_palette AS p",
  "  ON p.palette_id = CAST(hash(t.feature_name) % 256 AS INTEGER) + 1",
  sprintf("LIMIT %d", as.integer(max_transcripts) + 1L)
)

# -- 5. Zoom panel initial view state ------------------------------------------
main_panel_px <- as.integer(round(numeric_env("DBLENS_MAIN_PANEL_PX", 700)))
zoom_panel_px <- as.integer(round(numeric_env("DBLENS_ZOOM_PANEL_PX", 310)))
detail_panel_px <- as.integer(round(numeric_env("DBLENS_DETAIL_PANEL_PX", 390)))
detail_roi_fraction <- fraction_env("DBLENS_DETAIL_ROI_FRACTION", 0.34)
detail_roi_center_x <- fraction_env("DBLENS_DETAIL_ROI_CENTER_X", 0.34)
detail_roi_center_y <- fraction_env("DBLENS_DETAIL_ROI_CENTER_Y", 0.72)
detail_top_px <- as.integer(round(numeric_env("DBLENS_DETAIL_TOP_PX", 120)))
detail_grid_bins <- as.integer(round(numeric_env("DBLENS_DETAIL_GRID_BINS", 12)))

detail_roi_for <- function(src_roi) {
  src_w <- src_roi$xmax - src_roi$xmin
  src_h <- src_roi$ymax - src_roi$ymin
  detail_w <- src_w * detail_roi_fraction
  detail_h <- src_h * detail_roi_fraction
  detail_cx <- src_roi$xmin + src_w * detail_roi_center_x
  detail_cy <- src_roi$ymin + src_h * detail_roi_center_y

  if (detail_grid_bins > 1) {
    dense <- dbGetQuery(con, sprintf(
      "WITH binned AS (
         SELECT LEAST(%1$d - 1, GREATEST(0, FLOOR((x - %2$.17g) / %3$.17g))) AS bx,
                LEAST(%1$d - 1, GREATEST(0, FLOOR((y - %4$.17g) / %5$.17g))) AS by,
                COUNT(*) AS n,
                AVG(x) AS cx,
                AVG(y) AS cy
         FROM mgl_zoom_transcripts
         WHERE x BETWEEN %2$.17g AND %6$.17g
           AND y BETWEEN %4$.17g AND %7$.17g
         GROUP BY 1, 2
       )
       SELECT cx, cy, n FROM binned ORDER BY n DESC LIMIT 1",
      detail_grid_bins, src_roi$xmin, src_w / detail_grid_bins,
      src_roi$ymin, src_h / detail_grid_bins, src_roi$xmax, src_roi$ymax
    ))
    if (nrow(dense) && dense$n[[1L]] > 0) {
      detail_cx <- dense$cx[[1L]]
      detail_cy <- dense$cy[[1L]]
    }
  }

  out <- list(
    xmin = detail_cx - detail_w / 2,
    xmax = detail_cx + detail_w / 2,
    ymin = detail_cy - detail_h / 2,
    ymax = detail_cy + detail_h / 2
  )
  if (out$xmin < src_roi$xmin) {
    out$xmax <- out$xmax + (src_roi$xmin - out$xmin)
    out$xmin <- src_roi$xmin
  }
  if (out$xmax > src_roi$xmax) {
    out$xmin <- out$xmin - (out$xmax - src_roi$xmax)
    out$xmax <- src_roi$xmax
  }
  if (out$ymin < src_roi$ymin) {
    out$ymax <- out$ymax + (src_roi$ymin - out$ymin)
    out$ymin <- src_roi$ymin
  }
  if (out$ymax > src_roi$ymax) {
    out$ymin <- out$ymin - (out$ymax - src_roi$ymax)
    out$ymax <- src_roi$ymax
  }
  out
}

detail_roi <- detail_roi_for(roi)
n_detail_transcripts <- dbGetQuery(
  con, sprintf(
    "SELECT COUNT(*) AS n
     FROM mgl_zoom_transcripts
     WHERE x BETWEEN %.17g AND %.17g
       AND y BETWEEN %.17g AND %.17g",
    detail_roi$xmin, detail_roi$xmax, detail_roi$ymin, detail_roi$ymax
  )
)$n[[1L]]
message(
  "Detail ROI contains ",
  format(n_detail_transcripts, big.mark = ","),
  " visible transcript dots from the ROI transcript layer."
)

main_w   <- ext$xmax - ext$xmin
main_h   <- ext$ymax - ext$ymin
main_zoom <- log2(main_panel_px / (max(main_w, main_h) * 1.10))
main_cx   <- 0.5 * (ext$xmin + ext$xmax)
main_cy   <- 0.5 * (ext$ymin + ext$ymax)
roi_w    <- roi$xmax - roi$xmin
roi_h    <- roi$ymax - roi$ymin
roi_zoom <- log2(zoom_panel_px / (max(roi_w, roi_h) * 1.10))
roi_cx   <- 0.5 * (roi$xmin + roi$xmax)
roi_cy   <- 0.5 * (roi$ymin + roi$ymax)
detail_w <- detail_roi$xmax - detail_roi$xmin
detail_h <- detail_roi$ymax - detail_roi$ymin
detail_zoom <- log2(detail_panel_px / (max(detail_w, detail_h) * 1.10))
detail_cx <- 0.5 * (detail_roi$xmin + detail_roi$xmax)
detail_cy <- 0.5 * (detail_roi$ymin + detail_roi$ymax)

# -- 6. Mosaic spec - single main panel + zoom inset ---------------------------
# The ROI rectangle and connecting lines are drawn as an SVG overlay in JS
# so they project correctly as the user pans/zooms the main view.
main_centroid_radius_px <- numeric_env("DBLENS_MAIN_CENTROID_PX", 0.55)
zoom_centroid_radius_px <- 3.0
transcript_radius_px <- zoom_centroid_radius_px / 5
# Full-tissue polygons are drawn nearly opaque so the per-cell colour reads at
# overview scale; the insets fade them so transcript dots stay visible on top.
main_polygon_opacity <- fraction_env("DBLENS_MAIN_POLYGON_OPACITY", 0.98)
inset_polygon_opacity <- fraction_env("DBLENS_INSET_POLYGON_OPACITY", 0.38)

polygon_layer <- function(opacity) {
  list(
    `@@type`           = "GeoArrowPolygonLayer",
    id                 = "polys",
    data               = "polys",
    geometryColumn     = "geometry",
    getFillColor       = "@@=[r, g, b]",
    opacity            = opacity,
    stroked            = FALSE,
    getLineColor       = c(40L, 30L, 80L, 180L),
    lineWidthMinPixels = 0.4,
    coordinateSystem   = "@@#COORDINATE_SYSTEM.CARTESIAN",
    positionFormat     = "XY",
    pickable           = FALSE
  )
}
# Centroids carry the log10 transcript colour of their own cell in every deck,
# in the shade computed for that deck's polygon opacity (see centroid_shade).
scatter_layer <- function(radius_px, overview = FALSE) {
  list(
    `@@type`           = "ScatterplotLayer",
    id                 = "centroids",
    data               = "cells",
    getPosition        = "@@=[x, y]",
    getFillColor       = if (overview) "@@=[ov_r, ov_g, ov_b]" else "@@=[dr, dg, db]",
    getRadius          = radius_px,
    radiusUnits        = "pixels",
    stroked            = FALSE,
    lineWidthMinPixels = 0,
    coordinateSystem   = "@@#COORDINATE_SYSTEM.CARTESIAN",
    positionFormat     = "XY",
    opacity            = 0.9,
    parameters         = list(depthTest = FALSE),
    pickable           = FALSE
  )
}
transcript_layer <- function(data_name, layer_id = data_name) {
  list(
    `@@type`         = "ScatterplotLayer",
    id               = layer_id,
    data             = data_name,
    getPosition      = "@@=[x, y]",
    getFillColor     = "@@=[tx_r, tx_g, tx_b, tx_a]",
    getRadius        = transcript_radius_px,
    radiusUnits      = "pixels",
    coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
    positionFormat   = "XY",
    opacity          = 0.85,
    parameters       = list(depthTest = FALSE),
    pickable         = FALSE
  )
}

spec <- mgl_spec(
  meta = list(title = "Xenium WTA — ROI zoom inset with transcripts"),
  data = list(
    cells = mgl_data(type = "table",  df = centroids),
    polys = mgl_data(
      type = "duckdb", query = polygon_query, format = "geoarrow"
    ),
    transcripts = mgl_data(
      type = "duckdb", query = transcript_query, format = "arrow"
    )
  ),
  hconcat = list(
    mgl_deckgl(
      id     = "main",
      width  = main_panel_px, height = main_panel_px,
      title  = "Full tissue",
      tools  = character(0),
      initialViewState = list(
        target = list(main_cx, main_cy, 0),
        zoom   = main_zoom
      ),
      layers = list(polygon_layer(main_polygon_opacity),
                    scatter_layer(main_centroid_radius_px, overview = TRUE))
    ),
    mgl_deckgl(
      id     = "zoom",
      width  = zoom_panel_px, height = zoom_panel_px,
      title  = "Zoom: ROI",
      tools  = character(0),
      initialViewState = list(
        target = list(roi_cx, roi_cy, 0),
        zoom   = roi_zoom
      ),
      layers = list(
        polygon_layer(inset_polygon_opacity),
        transcript_layer("transcripts"),
        scatter_layer(zoom_centroid_radius_px)
      )
    ),
    mgl_deckgl(
      id     = "detail",
      width  = detail_panel_px, height = detail_panel_px,
      title  = "Detail: ROI",
      tools  = character(0),
      initialViewState = list(
        target = list(detail_cx, detail_cy, 0),
        zoom   = detail_zoom
      ),
      layers = list(
        polygon_layer(inset_polygon_opacity),
        transcript_layer("transcripts", "detail_transcripts"),
        scatter_layer(zoom_centroid_radius_px)
      )
    )
  )
)

# -- 7. Render + post-processing -----------------------------------------------
# ROI coords and data extents are injected as JS literals so the onRender
# callback can project them over the full-tissue panel.
roi_js <- sprintf(
  "{xmin:%f,xmax:%f,ymin:%f,ymax:%f}",
  roi$xmin, roi$xmax, roi$ymin, roi$ymax
)
ext_js <- sprintf(
  "{xmin:%f,xmax:%f,ymin:%f,ymax:%f}",
  ext$xmin, ext$xmax, ext$ymin, ext$ymax
)
zoom_js <- sprintf(
  "{cx:%f,cy:%f,zoom:%f,px:%d}",
  roi_cx, roi_cy, roi_zoom, zoom_panel_px
)
detail_roi_js <- sprintf(
  "{xmin:%f,xmax:%f,ymin:%f,ymax:%f}",
  detail_roi$xmin, detail_roi$xmax, detail_roi$ymin, detail_roi$ymax
)
detail_js <- sprintf(
  "{cx:%f,cy:%f,zoom:%f,px:%d,top:%d,relX:%f,relY:%f,fraction:%f,bins:%d}",
  detail_cx, detail_cy, detail_zoom, detail_panel_px, detail_top_px,
  detail_roi_center_x, detail_roi_center_y, detail_roi_fraction,
  detail_grid_bins
)
transcript_query_template_js <- jsonlite::toJSON(
  transcript_query_template,
  auto_unbox = TRUE
)
viewer <- mosaic_gl(spec, con = con,
                    width  = main_panel_px + detail_panel_px + 110,
                    height = max(main_panel_px + 60,
                                 detail_top_px + detail_panel_px + 40))

# nolint start: line_length_linter.
js_template <- '
function(el, x) {
  var ROI      = __ROI__;
  var DETAIL_ROI = __DETAIL_ROI__;
  var DATA_EXT = __EXT__;
  var ZOOM     = __ZOOM__;
  var DETAIL   = __DETAIL__;
  var SQL_TEMPLATE = __TRANSCRIPT_SQL__;
  var MAX_TRANSCRIPTS = __MAX_TRANSCRIPTS__;
  var Y_OFFSET = __YOFFSET__;
  var RED      = "#dc1c1c";
  var HIDE_CONTROLS = __HIDE_CONTROLS__;
  var ZOOM_PAD = 1.10;
  var refreshSeq = 0;

  var tries = 0;
  function setup() {
    var slots = el.querySelectorAll(".mosaic_gl-deckgl-slot");
    if (slots.length < 3) {
      if (++tries > 100) { console.warn("[06] deckgl slots not found"); return; }
      setTimeout(setup, 100);
      return;
    }
    var mainSlot = slots[0];
    var zoomSlot = slots[1];
    var detailSlot = slots[2];

    el.style.background = "#ffffff";
    el.style.overflow = "visible";
    [mainSlot, zoomSlot, detailSlot].forEach(function(s) {
      s.style.background = "#ffffff";
      s.style.overflow = "visible";
    });
    el.querySelectorAll("canvas").forEach(function(c) { c.style.background = "#ffffff"; });

    var lastTl = null;
    var lastZl = null;

    mainSlot.style.position = "relative";
    mainSlot.style.overflow = "visible";
    zoomSlot.style.cssText +=
      ";position:absolute;top:12px;right:12px;z-index:10" +
      ";border:2px solid " + RED + ";background:#ffffff";
    mainSlot.appendChild(zoomSlot);
    detailSlot.style.cssText +=
      ";position:absolute;top:" + DETAIL.top + "px;left:calc(100% + 18px)" +
      ";z-index:12;border:2px solid " + RED + ";background:#ffffff";
    mainSlot.appendChild(detailSlot);

    var statusDiv = document.createElement("div");
    statusDiv.style.cssText =
      "position:absolute;left:8px;bottom:8px;z-index:31;padding:4px 8px" +
      ";font-size:11px;color:#555;background:rgba(255,255,255,0.88)" +
      ";border:1px solid #ddd;border-radius:3px;display:none";
    mainSlot.appendChild(statusDiv);

    function setStatus(txt, isError) {
      statusDiv.textContent = txt || "";
      statusDiv.style.display = txt ? "block" : "none";
      statusDiv.style.color = isError ? "#b91c1c" : "#555";
    }

    el.querySelectorAll(".hconcat,[class*=hconcat]").forEach(function(row) {
      if (!row.querySelector(".mosaic_gl-deckgl-slot")) row.style.display = "none";
    });

    el.querySelectorAll("*").forEach(function(e) {
      var t = (e.childNodes.length === 1 && e.childNodes[0].nodeType === 3)
        ? e.textContent.trim() : "";
      if (t === "Full tissue" || t === "Zoom: ROI" || t === "Detail: ROI") {
        e.style.display = "none";
      }
    });

    function hideAllToolbars() {
      el.querySelectorAll(".mosaic_gl-toolbar").forEach(function(t) {
        t.style.display = "none";
      });
    }
    hideAllToolbars();
    var toolbarObserver = new MutationObserver(hideAllToolbars);
    toolbarObserver.observe(el, { childList: true, subtree: true });

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%" +
      ";pointer-events:none;z-index:5;overflow:visible";
    mainSlot.appendChild(svg);

    var detailSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    detailSvg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%" +
      ";pointer-events:none;z-index:24;overflow:visible";
    mainSlot.appendChild(detailSvg);

    var inSelectMode = false;
    var inDetailSelectMode = false;
    var selBtn = document.createElement("button");
    selBtn.type = "button";
    selBtn.textContent = "select";
    selBtn.style.cssText =
      "position:absolute;top:8px;left:8px;z-index:30;padding:3px 10px" +
      ";font-size:12px;font-weight:600;cursor:pointer;color:#dc1c1c" +
      ";background:#ffffff;border:1.5px solid #dc1c1c;border-radius:3px" +
      ";box-shadow:0 1px 3px rgba(0,0,0,0.15)";
    mainSlot.appendChild(selBtn);

    var detailBtn = document.createElement("button");
    detailBtn.type = "button";
    detailBtn.textContent = "detail";
    detailBtn.style.cssText =
      "position:absolute;top:8px;left:76px;z-index:30;padding:3px 10px" +
      ";font-size:12px;font-weight:600;cursor:pointer;color:#dc1c1c" +
      ";background:#ffffff;border:1.5px solid #dc1c1c;border-radius:3px" +
      ";box-shadow:0 1px 3px rgba(0,0,0,0.15)";
    mainSlot.appendChild(detailBtn);
    // Publication captures set DBLENS_HIDE_CONTROLS; the interactive session
    // keeps both buttons.
    if (HIDE_CONTROLS) {
      selBtn.style.display = "none";
      detailBtn.style.display = "none";
    }

    var selectDiv = document.createElement("div");
    selectDiv.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%" +
      ";z-index:8;cursor:crosshair;display:none";
    mainSlot.appendChild(selectDiv);

    var dragSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    dragSvg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none";
    selectDiv.appendChild(dragSvg);
    var dragRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    dragRect.setAttribute("fill", "rgba(220,28,28,0.08)");
    dragRect.setAttribute("stroke", RED);
    dragRect.setAttribute("stroke-width", "4");
    dragRect.setAttribute("stroke-linejoin", "round");
    dragSvg.appendChild(dragRect);

    var detailSelectDiv = document.createElement("div");
    detailSelectDiv.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%" +
      ";z-index:40;cursor:crosshair;display:none";
    zoomSlot.appendChild(detailSelectDiv);

    var detailDragSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    detailDragSvg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none";
    detailSelectDiv.appendChild(detailDragSvg);
    var detailDragRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    detailDragRect.setAttribute("fill", "rgba(220,28,28,0.08)");
    detailDragRect.setAttribute("stroke", RED);
    detailDragRect.setAttribute("stroke-width", "3");
    detailDragRect.setAttribute("stroke-linejoin", "round");
    detailDragSvg.appendChild(detailDragRect);

    function setMainSelectMode(active) {
      inSelectMode = active;
      selectDiv.style.display = active ? "block" : "none";
      selBtn.style.outline = active ? ("2px solid " + RED) : "";
      selBtn.style.fontWeight = active ? "bold" : "600";
    }

    function setDetailSelectMode(active) {
      inDetailSelectMode = active;
      detailSelectDiv.style.display = active ? "block" : "none";
      detailBtn.style.outline = active ? ("2px solid " + RED) : "";
      detailBtn.style.fontWeight = active ? "bold" : "600";
    }

    selBtn.addEventListener("click", function() {
      setDetailSelectMode(false);
      setMainSelectMode(!inSelectMode);
    });

    detailBtn.addEventListener("click", function() {
      setMainSelectMode(false);
      setDetailSelectMode(!inDetailSelectMode);
    });

    function findDeck(slot) {
      var found = null;
      slot.querySelectorAll("*").forEach(function(e) {
        if (!found && e.__deckInstance) found = e.__deckInstance;
      });
      if (found) return found;
      if (window.__mosaic_glInstances) {
        var ids = Object.keys(window.__mosaic_glInstances);
        for (var i = 0; i < ids.length && !found; i++) {
          var decks = window.__mosaic_glInstances[ids[i]].decks || [];
          for (var j = 0; j < decks.length && !found; j++) {
            var d = decks[j];
            if (d && d.canvas && slot.contains(d.canvas)) found = d.deck || null;
          }
        }
      }
      return found;
    }

    function findPanel(slot) {
      var found = null;
      slot.querySelectorAll("*").forEach(function(e) {
        if (!found && e.__mosaic_glPanel) found = e.__mosaic_glPanel;
      });
      return found;
    }

    function project(deck, dataX, dataY) {
      if (deck) {
        var vps = deck.getViewports && deck.getViewports();
        if (vps && vps.length) {
          var p = vps[0].project([dataX, dataY]);
          if (p && isFinite(p[0]) && isFinite(p[1])) return p;
        }
      }
      var W = mainSlot.offsetWidth  || __WPANEL__;
      var H = mainSlot.offsetHeight || __WPANEL__;
      var extW = DATA_EXT.xmax - DATA_EXT.xmin;
      var extH = DATA_EXT.ymax - DATA_EXT.ymin;
      var scale = Math.min(W / extW, H / extH) * 0.95;
      var tcx   = 0.5 * (DATA_EXT.xmin + DATA_EXT.xmax);
      var tcy   = 0.5 * (DATA_EXT.ymin + DATA_EXT.ymax);
      return [
        (dataX - tcx) * scale + W / 2,
        (dataY - tcy) * scale + H / 2
      ];
    }

    function unproject(deck, sx, sy) {
      if (deck) {
        var vps = deck.getViewports && deck.getViewports();
        if (vps && vps.length) {
          var p = vps[0].unproject([sx, sy]);
          if (p && isFinite(p[0]) && isFinite(p[1])) return p;
        }
      }
      var W = mainSlot.offsetWidth  || __WPANEL__;
      var H = mainSlot.offsetHeight || __WPANEL__;
      var extW = DATA_EXT.xmax - DATA_EXT.xmin;
      var extH = DATA_EXT.ymax - DATA_EXT.ymin;
      var scale = Math.min(W / extW, H / extH) * 0.95;
      var tcx   = 0.5 * (DATA_EXT.xmin + DATA_EXT.xmax);
      var tcy   = 0.5 * (DATA_EXT.ymin + DATA_EXT.ymax);
      return [
        (sx - W / 2) / scale + tcx,
        (sy - H / 2) / scale + tcy
      ];
    }

    function unprojectInSlot(slot, deck, sx, sy) {
      if (deck) {
        var vps = deck.getViewports && deck.getViewports();
        if (vps && vps.length) {
          var p = vps[0].unproject([sx, sy]);
          if (p && isFinite(p[0]) && isFinite(p[1])) return p;
        }
      }
      var panel = findPanel(slot);
      var vs = panel && typeof panel.getViewState === "function"
        ? panel.getViewState() : null;
      if (vs && Array.isArray(vs.target)) {
        var W = slot.offsetWidth || ZOOM.px;
        var H = slot.offsetHeight || ZOOM.px;
        var scale = Math.pow(2, Number(vs.zoom) || 0);
        return [
          vs.target[0] + (sx - W / 2) / scale,
          vs.target[1] - (sy - H / 2) / scale
        ];
      }
      return unproject(deck, sx, sy);
    }

    function projectInSlot(slot, deck, dataX, dataY) {
      var p = null;
      if (deck) {
        var vps = deck.getViewports && deck.getViewports();
        if (vps && vps.length) {
          p = vps[0].project([dataX, dataY]);
        }
      }
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) p = [0, 0];
      var mR = mainSlot.getBoundingClientRect();
      var sR = slot.getBoundingClientRect();
      return [sR.left - mR.left + p[0], sR.top - mR.top + p[1]];
    }

    function clampROIToParent(roi, parent) {
      var out = {
        xmin: Math.max(parent.xmin, Math.min(parent.xmax, roi.xmin)),
        xmax: Math.max(parent.xmin, Math.min(parent.xmax, roi.xmax)),
        ymin: Math.max(parent.ymin, Math.min(parent.ymax, roi.ymin)),
        ymax: Math.max(parent.ymin, Math.min(parent.ymax, roi.ymax))
      };
      if (out.xmax < out.xmin) {
        var tx = out.xmin;
        out.xmin = out.xmax;
        out.xmax = tx;
      }
      if (out.ymax < out.ymin) {
        var ty = out.ymin;
        out.ymin = out.ymax;
        out.ymax = ty;
      }
      return out;
    }

    function countRowsInROI(rows, roi) {
      if (!Array.isArray(rows) || !rows.length) return 0;
      var n = 0;
      rows.forEach(function(row) {
        var x0 = Number(row && row.x);
        var y0 = Number(row && row.y);
        if (isFinite(x0) && isFinite(y0) &&
            x0 >= roi.xmin && x0 <= roi.xmax &&
            y0 >= roi.ymin && y0 <= roi.ymax) {
          n++;
        }
      });
      return n;
    }

    function detailRoiForROI(roi, rows) {
      var srcW = roi.xmax - roi.xmin;
      var srcH = roi.ymax - roi.ymin;
      var detailW = srcW * DETAIL.fraction;
      var detailH = srcH * DETAIL.fraction;
      var cx = roi.xmin + srcW * DETAIL.relX;
      var cy = roi.ymin + srcH * DETAIL.relY;
      if (Array.isArray(rows) && rows.length && DETAIL.bins > 1) {
        var bins = Math.max(2, Math.round(DETAIL.bins));
        var binW = srcW / bins;
        var binH = srcH / bins;
        var counts = new Map();
        rows.forEach(function(row) {
          var x0 = Number(row && row.x);
          var y0 = Number(row && row.y);
          if (!isFinite(x0) || !isFinite(y0)) return;
          if (x0 < roi.xmin || x0 > roi.xmax || y0 < roi.ymin || y0 > roi.ymax) return;
          var bx = Math.min(bins - 1, Math.max(0, Math.floor((x0 - roi.xmin) / binW)));
          var by = Math.min(bins - 1, Math.max(0, Math.floor((y0 - roi.ymin) / binH)));
          var key = bx + ":" + by;
          var entry = counts.get(key) || { n: 0, sx: 0, sy: 0 };
          entry.n += 1;
          entry.sx += x0;
          entry.sy += y0;
          counts.set(key, entry);
        });
        var best = null;
        counts.forEach(function(entry) {
          if (!best || entry.n > best.n) best = entry;
        });
        if (best && best.n > 0) {
          cx = best.sx / best.n;
          cy = best.sy / best.n;
        }
      }
      var out = {
        xmin: cx - detailW / 2,
        xmax: cx + detailW / 2,
        ymin: cy - detailH / 2,
        ymax: cy + detailH / 2
      };
      if (out.xmin < roi.xmin) {
        out.xmax += roi.xmin - out.xmin;
        out.xmin = roi.xmin;
      }
      if (out.xmax > roi.xmax) {
        out.xmin -= out.xmax - roi.xmax;
        out.xmax = roi.xmax;
      }
      if (out.ymin < roi.ymin) {
        out.ymax += roi.ymin - out.ymin;
        out.ymin = roi.ymin;
      }
      if (out.ymax > roi.ymax) {
        out.ymin -= out.ymax - roi.ymax;
        out.ymax = roi.ymax;
      }
      return out;
    }

    function viewStateForROI(roi, panelPx) {
      var roiW = roi.xmax - roi.xmin;
      var roiH = roi.ymax - roi.ymin;
      return {
        target: [0.5 * (roi.xmin + roi.xmax), 0.5 * (roi.ymin + roi.ymax), 0],
        zoom: Math.log2(panelPx / (Math.max(roiW, roiH) * ZOOM_PAD)),
        transitionDuration: 400
      };
    }

    function setPanelROI(slot, roi, fallbackPx) {
      var panel = findPanel(slot);
      var deck = findDeck(slot);
      var panelPx = (slot.clientWidth && slot.clientHeight)
        ? Math.min(slot.clientWidth, slot.clientHeight)
        : fallbackPx;
      var vs = viewStateForROI(roi, panelPx);
      if (panel && typeof panel.setViewState === "function") {
        panel.setViewState(vs);
      } else if (deck) {
        try { deck.setProps({ viewState: vs }); } catch (err) {}
        try { deck.setProps({ initialViewState: vs }); } catch (err) {}
      }
    }

    function sqlNumber(v) {
      v = Number(v);
      if (!isFinite(v)) throw new Error("Invalid ROI coordinate");
      return v.toPrecision(17);
    }

    function transcriptSqlForROI(roi) {
      var rawYMin = Math.min(Y_OFFSET - roi.ymin, Y_OFFSET - roi.ymax);
      var rawYMax = Math.max(Y_OFFSET - roi.ymin, Y_OFFSET - roi.ymax);
      return SQL_TEMPLATE
        .split("__XMIN__").join(sqlNumber(roi.xmin))
        .split("__XMAX__").join(sqlNumber(roi.xmax))
        .split("__YMIN__").join(sqlNumber(roi.ymin))
        .split("__YMAX__").join(sqlNumber(roi.ymax))
        .split("__RAW_YMIN__").join(sqlNumber(rawYMin))
        .split("__RAW_YMAX__").join(sqlNumber(rawYMax));
    }

    async function refreshTranscriptsForROI() {
      var seq = ++refreshSeq;
      var inst = window.__mosaic_glInstances && window.__mosaic_glInstances[x.widgetId];
      var zoomPanel = findPanel(zoomSlot);
      var detailPanel = findPanel(detailSlot);
      if (!inst || typeof inst.queryServer !== "function" ||
          typeof inst.setRowsData !== "function" ||
          !zoomPanel || typeof zoomPanel.refreshData !== "function" ||
          !detailPanel || typeof detailPanel.refreshData !== "function") {
        setStatus("Run this demo through Shiny to refresh transcripts.", true);
        return;
      }
      setStatus("Querying transcripts for selected ROI...");
      try {
        var response = await inst.queryServer(transcriptSqlForROI(ROI), "json");
        if (seq !== refreshSeq) return;
        var zoomRows = response.rows || [];
        if (zoomRows.length > MAX_TRANSCRIPTS) {
          throw new Error("ROI exceeds transcript limit " + MAX_TRANSCRIPTS.toLocaleString() +
            "; select a smaller ROI. Previous transcript data is unchanged.");
        }
        DETAIL_ROI = detailRoiForROI(ROI, zoomRows);
        setPanelROI(detailSlot, DETAIL_ROI, DETAIL.px);
        drawOverlay();
        var zoomEntry = inst.setRowsData("transcripts", zoomRows);
        var refreshed = await Promise.all([
          zoomPanel.refreshData("transcripts"),
          detailPanel.refreshData("transcripts")
        ]);
        var resolved = refreshed[0];
        var layer = Array.isArray(resolved) ? resolved.find(function(r) {
          return r && r.dataName === "transcripts";
        }) : null;
        var nZoom = layer && Array.isArray(layer.rows)
          ? layer.rows.length
          : (zoomEntry && Array.isArray(zoomEntry.rows) ? zoomEntry.rows.length : 0);
        var nDetail = countRowsInROI(zoomRows, DETAIL_ROI);

        setStatus(
          "Updated " + nZoom.toLocaleString() +
          " ROI transcript dots; detail view contains " +
          nDetail.toLocaleString() + " of those rows."
        );
      } catch (err) {
        setStatus("Transcript refresh failed: " + (err.message || err), true);
        console.warn("[06] transcript refresh failed", err);
      }
    }

    function drawOverlay() {
      svg.innerHTML = "";
      detailSvg.innerHTML = "";
      var deck = findDeck(mainSlot);
      var zoomDeck = findDeck(zoomSlot);

      var tl = project(deck, ROI.xmin, ROI.ymin);
      var tr = project(deck, ROI.xmax, ROI.ymin);
      var br = project(deck, ROI.xmax, ROI.ymax);
      var bl = project(deck, ROI.xmin, ROI.ymax);

      function polygon(parent, points, fillAlpha, width) {
        var poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        poly.setAttribute("points", points.map(function(p){
          return p[0].toFixed(1) + "," + p[1].toFixed(1);
        }).join(" "));
        poly.setAttribute("fill", "rgba(220,28,28," + fillAlpha + ")");
        poly.setAttribute("stroke", RED);
        poly.setAttribute("stroke-width", width);
        poly.setAttribute("stroke-linejoin", "round");
        parent.appendChild(poly);
        return poly;
      }
      polygon(svg, [tl, tr, br, bl], "0.06", "4");

      var dtl = projectInSlot(zoomSlot, zoomDeck, DETAIL_ROI.xmin, DETAIL_ROI.ymin);
      var dtr = projectInSlot(zoomSlot, zoomDeck, DETAIL_ROI.xmax, DETAIL_ROI.ymin);
      var dbr = projectInSlot(zoomSlot, zoomDeck, DETAIL_ROI.xmax, DETAIL_ROI.ymax);
      var dbl = projectInSlot(zoomSlot, zoomDeck, DETAIL_ROI.xmin, DETAIL_ROI.ymax);
      polygon(detailSvg, [dtl, dtr, dbr, dbl], "0.04", "3");

      var mR    = mainSlot.getBoundingClientRect();
      var zRect = zoomSlot.getBoundingClientRect();
      var zL = zRect.left   - mR.left;
      var zR = zRect.right  - mR.left;
      var zT = zRect.top    - mR.top;
      var zB = zRect.bottom - mR.top;
      var detailRect = detailSlot.getBoundingClientRect();
      var detailL = detailRect.left   - mR.left;
      var detailT = detailRect.top    - mR.top;
      var detailB = detailRect.bottom - mR.top;

      function line(parent, x1, y1, x2, y2) {
        var l = document.createElementNS("http://www.w3.org/2000/svg", "line");
        l.setAttribute("x1", x1.toFixed(1)); l.setAttribute("y1", y1.toFixed(1));
        l.setAttribute("x2", x2.toFixed(1)); l.setAttribute("y2", y2.toFixed(1));
        l.setAttribute("stroke",       RED);
        l.setAttribute("stroke-width", "4");
        l.setAttribute("stroke-linecap", "round");
        parent.appendChild(l);
      }
      line(svg, bl[0], bl[1], zL, zT);
      line(svg, tr[0], tr[1], zR, zB);
      line(detailSvg, dbr[0], dbr[1], detailL, detailT);
      line(detailSvg, dtr[0], dtr[1], detailL, detailB);
    }

    function rafLoop() {
      // The overlay draws the ROI rectangle through the MAIN deck and the
      // detail rectangle through the ZOOM deck, so it has to be redrawn when
      // either transform moves. Watching only the main deck left the detail
      // rectangle stale after a new ROI: setPanelROI() changes the zoom view
      // asynchronously, so the drawOverlay() call in the handler still
      // projected through the old zoom view, and nothing redrew it until an
      // unrelated main-view interaction happened to move `tl`.
      var tl = project(findDeck(mainSlot), ROI.xmin, ROI.ymin);
      var zoomDeck = findDeck(zoomSlot);
      var zl = zoomDeck
        ? projectInSlot(zoomSlot, zoomDeck, DETAIL_ROI.xmin, DETAIL_ROI.ymin)
        : null;
      var moved =
        !lastTl ||
        Math.abs(tl[0] - lastTl[0]) > 0.3 || Math.abs(tl[1] - lastTl[1]) > 0.3 ||
        (zl && (!lastZl ||
                Math.abs(zl[0] - lastZl[0]) > 0.3 || Math.abs(zl[1] - lastZl[1]) > 0.3));
      if (moved) {
        drawOverlay();
        lastTl = tl;
        if (zl) lastZl = zl;
      }
      requestAnimationFrame(rafLoop);
    }

    var dragStart = null;
    selectDiv.addEventListener("mousedown", function(e) {
      var r = selectDiv.getBoundingClientRect();
      dragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
      dragRect.setAttribute("x", dragStart.x);
      dragRect.setAttribute("y", dragStart.y);
      dragRect.setAttribute("width", 0);
      dragRect.setAttribute("height", 0);
      e.preventDefault();
    });

    selectDiv.addEventListener("mousemove", function(e) {
      if (!dragStart) return;
      var r = selectDiv.getBoundingClientRect();
      var cx = e.clientX - r.left;
      var cy = e.clientY - r.top;
      dragRect.setAttribute("x", Math.min(dragStart.x, cx));
      dragRect.setAttribute("y", Math.min(dragStart.y, cy));
      dragRect.setAttribute("width", Math.abs(cx - dragStart.x));
      dragRect.setAttribute("height", Math.abs(cy - dragStart.y));
    });

    selectDiv.addEventListener("mouseup", function(e) {
      if (!dragStart) return;
      var r = selectDiv.getBoundingClientRect();
      var cx = e.clientX - r.left;
      var cy = e.clientY - r.top;
      var sx = Math.min(dragStart.x, cx);
      var sy = Math.min(dragStart.y, cy);
      var sw = Math.abs(cx - dragStart.x);
      var sh = Math.abs(cy - dragStart.y);
      dragStart = null;
      dragRect.setAttribute("width", 0);
      dragRect.setAttribute("height", 0);
      if (sw < 8 || sh < 8) return;

      var deck = findDeck(mainSlot);
      var p1 = unproject(deck, sx, sy);
      var p2 = unproject(deck, sx + sw, sy + sh);
      ROI = {
        xmin: Math.min(p1[0], p2[0]), xmax: Math.max(p1[0], p2[0]),
        ymin: Math.min(p1[1], p2[1]), ymax: Math.max(p1[1], p2[1])
      };
      DETAIL_ROI = detailRoiForROI(ROI, []);

      setPanelROI(zoomSlot, ROI, ZOOM.px);
      setPanelROI(detailSlot, DETAIL_ROI, DETAIL.px);

      setMainSelectMode(false);
      lastTl = null;
      lastZl = null;
      drawOverlay();
      refreshTranscriptsForROI();
    });

    var detailDragStart = null;
    detailSelectDiv.addEventListener("mousedown", function(e) {
      var r = detailSelectDiv.getBoundingClientRect();
      detailDragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
      detailDragRect.setAttribute("x", detailDragStart.x);
      detailDragRect.setAttribute("y", detailDragStart.y);
      detailDragRect.setAttribute("width", 0);
      detailDragRect.setAttribute("height", 0);
      e.preventDefault();
    });

    detailSelectDiv.addEventListener("mousemove", function(e) {
      if (!detailDragStart) return;
      var r = detailSelectDiv.getBoundingClientRect();
      var cx = e.clientX - r.left;
      var cy = e.clientY - r.top;
      detailDragRect.setAttribute("x", Math.min(detailDragStart.x, cx));
      detailDragRect.setAttribute("y", Math.min(detailDragStart.y, cy));
      detailDragRect.setAttribute("width", Math.abs(cx - detailDragStart.x));
      detailDragRect.setAttribute("height", Math.abs(cy - detailDragStart.y));
    });

    detailSelectDiv.addEventListener("mouseup", function(e) {
      if (!detailDragStart) return;
      var r = detailSelectDiv.getBoundingClientRect();
      var cx = e.clientX - r.left;
      var cy = e.clientY - r.top;
      var sx = Math.min(detailDragStart.x, cx);
      var sy = Math.min(detailDragStart.y, cy);
      var sw = Math.abs(cx - detailDragStart.x);
      var sh = Math.abs(cy - detailDragStart.y);
      detailDragStart = null;
      detailDragRect.setAttribute("width", 0);
      detailDragRect.setAttribute("height", 0);
      if (sw < 8 || sh < 8) return;

      var zoomDeck = findDeck(zoomSlot);
      var p1 = unprojectInSlot(zoomSlot, zoomDeck, sx, sy);
      var p2 = unprojectInSlot(zoomSlot, zoomDeck, sx + sw, sy + sh);
      DETAIL_ROI = clampROIToParent({
        xmin: Math.min(p1[0], p2[0]), xmax: Math.max(p1[0], p2[0]),
        ymin: Math.min(p1[1], p2[1]), ymax: Math.max(p1[1], p2[1])
      }, ROI);

      setPanelROI(detailSlot, DETAIL_ROI, DETAIL.px);
      setDetailSelectMode(false);
      lastTl = null;
      lastZl = null;
      drawOverlay();
      setStatus("Updated detail view without refetching transcripts.");
    });

    setTimeout(function() { rafLoop(); }, 600);
  }

  setup();
}
'
js_code <- gsub("__ROI__",    roi_js,                      js_template, fixed = TRUE)
js_code <- gsub("__DETAIL_ROI__", detail_roi_js,            js_code,     fixed = TRUE)
js_code <- gsub("__EXT__",    ext_js,                      js_code,     fixed = TRUE)
js_code <- gsub("__ZOOM__",   zoom_js,                     js_code,     fixed = TRUE)
js_code <- gsub("__DETAIL__", detail_js,                   js_code,     fixed = TRUE)
js_code <- gsub("__TRANSCRIPT_SQL__", transcript_query_template_js,
                js_code, fixed = TRUE)
js_code <- gsub("__MAX_TRANSCRIPTS__", as.character(as.integer(max_transcripts)),
                js_code, fixed = TRUE)
js_code <- gsub("__YOFFSET__", sprintf("%.17g", y_offset),
                js_code, fixed = TRUE)
js_code <- gsub("__WPANEL__", as.character(main_panel_px), js_code,     fixed = TRUE)
hide_controls <- tolower(Sys.getenv("DBLENS_HIDE_CONTROLS", unset = "false")) %in% c("true", "1", "yes")
js_code <- gsub("__HIDE_CONTROLS__", if (hide_controls) "true" else "false", js_code, fixed = TRUE)
viewer <- htmlwidgets::onRender(viewer, js_code)
# nolint end

if (interactive()) {
  install_query_handler <- getFromNamespace(
    ".install_shiny_query_handler",
    "dbVisuals"
  )
  app <- shiny::shinyApp(
    ui = shiny::fluidPage(
      shiny::tags$style(
        "body { margin: 0; background: #fff; } .container-fluid { padding: 0; }"
      ),
      dbVisuals::mosaic_glOutput("viewer", width = "100%", height = "780px")
    ),
    server = function(input, output, session) {
      output$viewer <- dbVisuals::renderMosaic_gl({
        install_query_handler(session, viewer$x$widgetId, con)
        shiny_viewer <- viewer
        shiny_viewer$x$hasShiny <- TRUE
        shiny_viewer
      })
    }
  )
  shiny::runApp(app)
} else {
  print(viewer)
}
