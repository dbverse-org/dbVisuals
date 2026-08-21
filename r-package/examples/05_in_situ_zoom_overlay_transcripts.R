# dbVisuals demo 5 - in-situ plot + ROI zoom inset with transcripts.
#
# This recreates examples/02_in_situ_zoom_overlay.R, but keeps the full-tissue
# panel unchanged except for larger centroid dots. Real transcript dots are
# transported and rendered only for the static ROI shown in the zoom inset.
#
# Visual design matches the publication figure in paper/outputs/examples:
#   - White background
#   - Red rectangle marks the ROI on the full-tissue panel
#   - Red connecting lines run from the ROI's right corners to the inset's
#     left corners
#   - The zoom inset overlays cell polygons, enlarged centroids, and transcript
#     dots. Transcript radius is exactly one fifth of the zoom centroid radius.

suppressPackageStartupMessages({
  library(DBI)
  library(duckdb)
  library(dbVisuals)
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
  set.seed(1)
  centroids$total_expr <- pmax(0, round(rnorm(nrow(centroids), 200, 80)))
  centroids$nr_feats   <- pmax(0, round(rnorm(nrow(centroids), 30, 10)))
  centroids$cluster    <- paste0("c", sample.int(8L, nrow(centroids), TRUE))
}

pal  <- grDevices::hcl.colors(length(unique(centroids$cluster)), "Dark 3")
rgb_ <- grDevices::col2rgb(pal[as.integer(factor(centroids$cluster))])
centroids$r <- as.integer(rgb_[1, ])
centroids$g <- as.integer(rgb_[2, ])
centroids$b <- as.integer(rgb_[3, ])

polygon_alpha <- as.integer(round(0.42 * 255))
polygon_query <- sprintf(
  "SELECT p.poly_ID AS cell_ID,
          %s AS geometry
   FROM %s AS p
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
  roi$xmin, roi$xmax, roi$ymin, roi$ymax, qv_predicate, gene_predicate
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

transcript_query <- paste(
  "SELECT t.transcript_ID, t.cell_ID, t.feature_name, t.x, t.y,",
  "       p.tx_r, p.tx_g, p.tx_b,",
  "       210 AS tx_a",
  "FROM mgl_zoom_transcripts AS t",
  "LEFT JOIN mgl_transcript_palette AS p",
  "  ON p.palette_id = CAST(hash(t.feature_name) % 256 AS INTEGER) + 1"
)

# -- 5. Zoom panel initial view state ------------------------------------------
main_panel_px <- 700
zoom_panel_px <- 290
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

# -- 6. Mosaic spec - single main panel + zoom inset ---------------------------
# The ROI rectangle and connecting lines are drawn as an SVG overlay in JS
# so they project correctly as the user pans/zooms the main view.
main_centroid_radius_px <- 1.8
zoom_centroid_radius_px <- 3.0
transcript_radius_px <- zoom_centroid_radius_px / 5

polygon_layer <- list(
  `@@type`           = "GeoArrowPolygonLayer",
  id                 = "polys",
  data               = "polys",
  geometryColumn     = "geometry",
  getFillColor       = c(157L, 78L, 221L, polygon_alpha),
  stroked            = FALSE,
  getLineColor       = c(40L, 30L, 80L, 180L),
  lineWidthMinPixels = 0.4,
  coordinateSystem   = "@@#COORDINATE_SYSTEM.CARTESIAN",
  positionFormat     = "XY",
  pickable           = FALSE
)
scatter_layer <- function(radius_px) {
  list(
    `@@type`         = "ScatterplotLayer",
    id               = "centroids",
    data             = "cells",
    getPosition      = "@@=[x, y]",
    getFillColor     = "@@=[r, g, b]",
    getRadius        = radius_px,
    radiusUnits      = "pixels",
    coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
    positionFormat   = "XY",
    opacity          = 0.85,
    parameters       = list(depthTest = FALSE),
    pickable         = FALSE
  )
}
transcript_layer <- list(
  `@@type`         = "ScatterplotLayer",
  id               = "transcripts",
  data             = "transcripts",
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
      layers = list(polygon_layer, scatter_layer(main_centroid_radius_px))
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
        polygon_layer,
        transcript_layer,
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
viewer <- mosaic_gl(spec, con = con,
                    width  = main_panel_px + 40,
                    height = main_panel_px + 60)

# nolint start: line_length_linter.
js_template <- '
function(el, x) {
  var ROI      = __ROI__;
  var DATA_EXT = __EXT__;
  var RED      = "#dc1c1c";

  var tries = 0;
  function setup() {
    var slots = el.querySelectorAll(".mosaic_gl-deckgl-slot");
    if (slots.length < 2) {
      if (++tries > 100) { console.warn("[05] deckgl slots not found"); return; }
      setTimeout(setup, 100);
      return;
    }
    var mainSlot = slots[0];
    var zoomSlot = slots[1];

    el.style.background = "#ffffff";
    [mainSlot, zoomSlot].forEach(function(s) { s.style.background = "#ffffff"; });
    el.querySelectorAll("canvas").forEach(function(c) { c.style.background = "#ffffff"; });

    var lastTl = null;

    mainSlot.style.position = "relative";
    zoomSlot.style.cssText +=
      ";position:absolute;top:12px;right:12px;z-index:10" +
      ";border:2px solid " + RED + ";background:#ffffff";
    mainSlot.appendChild(zoomSlot);

    el.querySelectorAll(".hconcat,[class*=hconcat]").forEach(function(row) {
      if (!row.querySelector(".mosaic_gl-deckgl-slot")) row.style.display = "none";
    });

    el.querySelectorAll("*").forEach(function(e) {
      var t = (e.childNodes.length === 1 && e.childNodes[0].nodeType === 3)
        ? e.textContent.trim() : "";
      if (t === "Full tissue" || t === "Zoom: ROI") e.style.display = "none";
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

    function drawOverlay() {
      svg.innerHTML = "";
      var deck = findDeck(mainSlot);

      var tl = project(deck, ROI.xmin, ROI.ymin);
      var tr = project(deck, ROI.xmax, ROI.ymin);
      var br = project(deck, ROI.xmax, ROI.ymax);
      var bl = project(deck, ROI.xmin, ROI.ymax);

      var poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", [tl,tr,br,bl].map(function(p){
        return p[0].toFixed(1) + "," + p[1].toFixed(1);
      }).join(" "));
      poly.setAttribute("fill",         "rgba(220,28,28,0.06)");
      poly.setAttribute("stroke",       RED);
      poly.setAttribute("stroke-width", "4");
      poly.setAttribute("stroke-linejoin", "round");
      svg.appendChild(poly);

      var mR    = mainSlot.getBoundingClientRect();
      var zRect = zoomSlot.getBoundingClientRect();
      var zL = zRect.left   - mR.left;
      var zR = zRect.right  - mR.left;
      var zT = zRect.top    - mR.top;
      var zB = zRect.bottom - mR.top;

      function line(x1, y1, x2, y2) {
        var l = document.createElementNS("http://www.w3.org/2000/svg", "line");
        l.setAttribute("x1", x1.toFixed(1)); l.setAttribute("y1", y1.toFixed(1));
        l.setAttribute("x2", x2.toFixed(1)); l.setAttribute("y2", y2.toFixed(1));
        l.setAttribute("stroke",       RED);
        l.setAttribute("stroke-width", "4");
        l.setAttribute("stroke-linecap", "round");
        svg.appendChild(l);
      }
      line(bl[0], bl[1], zL, zT);
      line(tr[0], tr[1], zR, zB);
    }

    function rafLoop() {
      var deck = findDeck(mainSlot);
      var tl   = project(deck, ROI.xmin, ROI.ymin);
      if (!lastTl || Math.abs(tl[0] - lastTl[0]) > 0.3 || Math.abs(tl[1] - lastTl[1]) > 0.3) {
        drawOverlay();
        lastTl = tl;
      }
      requestAnimationFrame(rafLoop);
    }

    setTimeout(function() { rafLoop(); }, 600);
  }

  setup();
}
'
js_code <- gsub("__ROI__",    roi_js,                      js_template, fixed = TRUE)
js_code <- gsub("__EXT__",    ext_js,                      js_code,     fixed = TRUE)
js_code <- gsub("__WPANEL__", as.character(main_panel_px), js_code,     fixed = TRUE)
viewer <- htmlwidgets::onRender(viewer, js_code)
# nolint end

print(viewer)
