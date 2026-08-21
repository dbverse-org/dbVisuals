# dbVisuals demo 4 - cell polygons, centroids, and subcellular transcripts.
#
# This example is intentionally separate from 01_in_situ_with_marginals.R.
# The supplied GiottoDB file contains cell polygons and cell-level expression,
# but not molecule coordinates. To draw real transcript dots, provide either:
#
#   Sys.setenv(DBLENS_TRANSCRIPT_FILE = "/path/to/transcripts.parquet")
#   source("examples/04_in_situ_with_transcripts.R")
#
# or add a coordinate-level relation to the DuckDB and set:
#
#   Sys.setenv(DBLENS_TRANSCRIPT_TABLE = "transcripts")
#
# A 10x Xenium `transcripts.parquet` file is accepted directly; expected fields
# include `cell_id`, `feature_name`, `x_location`, and `y_location`.
#
# Only a bounded ROI is transported into the htmlwidget. Molecule-level Xenium
# output can contain many millions of rows, so embedding the whole table in a
# standalone widget is generally not useful.

suppressPackageStartupMessages({
  library(DBI)
  library(duckdb)
  library(dbVisuals)
})

# Point DBLENS_DEMO_DB at your database; the fallback is a file of that name in
# the working directory, so the script carries no machine-specific path.
db_path <- Sys.getenv(
  "DBLENS_DEMO_DB",
  unset = "WTA_Preview_FFPE_Breast_Cancer_xenium.duckdb"
)
if (!file.exists(db_path)) {
  stop("Demo DB not found at '", db_path, "'. Set DBLENS_DEMO_DB.")
}
db_path <- normalizePath(db_path, mustWork = TRUE)
con <- dbConnect(duckdb(), dbdir = db_path, read_only = TRUE)

for (sql in c(
  "INSTALL spatial", "LOAD spatial",
  "INSTALL nanoarrow FROM community", "LOAD nanoarrow",
  "CALL register_geoarrow_extensions()"
)) try(dbExecute(con, sql), silent = TRUE)

qi <- function(x) as.character(dbQuoteIdentifier(con, x))
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

# -- Cell geometry and ROI -----------------------------------------------------
tables <- dbListTables(con)
if (!"gdb_poly_cell" %in% tables) {
  stop("This example requires a gdb_poly_cell(poly_ID, geom) table.")
}

geom_type <- dbGetQuery(con, paste(
  "SELECT data_type FROM information_schema.columns",
  "WHERE table_name = 'gdb_poly_cell' AND column_name = 'geom'"
))
geom_is_geometry <- nrow(geom_type) > 0 &&
  grepl("GEOMETRY", toupper(as.character(geom_type$data_type[[1L]])))
geom_expr <- if (geom_is_geometry) "geom" else "ST_GeomFromWKB(geom)"
geom_p <- gsub("\\bgeom\\b", "p.geom", geom_expr)

extent <- dbGetQuery(con, sprintf(
  "SELECT MIN(ST_XMin(%1$s)) AS xmin, MAX(ST_XMax(%1$s)) AS xmax,
          MIN(ST_YMin(%1$s)) AS ymin, MAX(ST_YMax(%1$s)) AS ymax
   FROM gdb_poly_cell WHERE %1$s IS NOT NULL AND NOT ST_IsEmpty(%1$s)",
  geom_expr
))
y_offset <- extent$ymin[[1L]] + extent$ymax[[1L]]
full_center_x <- 0.5 * (extent$xmin[[1L]] + extent$xmax[[1L]])
full_center_y <- 0.5 * (extent$ymin[[1L]] + extent$ymax[[1L]])

focus_cell_id <- Sys.getenv("DBLENS_ROI_CELL_ID", unset = "")
if (nzchar(focus_cell_id)) {
  focus <- dbGetQuery(con, sprintf(
    "SELECT p.poly_ID AS cell_ID,
            ST_X(ST_Centroid(%s)) AS x, ST_Y(ST_Centroid(%s)) AS y
     FROM gdb_poly_cell AS p WHERE p.poly_ID = %s LIMIT 1",
    geom_p, geom_p, dbQuoteString(con, focus_cell_id)
  ))
  if (!nrow(focus)) stop("DBLENS_ROI_CELL_ID was not found: ", focus_cell_id)
} else {
  focus <- dbGetQuery(con, sprintf(
    "SELECT p.poly_ID AS cell_ID,
            ST_X(ST_Centroid(%1$s)) AS x, ST_Y(ST_Centroid(%1$s)) AS y
     FROM gdb_poly_cell AS p
     WHERE %1$s IS NOT NULL AND NOT ST_IsEmpty(%1$s)
     ORDER BY POWER(ST_X(ST_Centroid(%1$s)) - %2$f, 2) +
              POWER(ST_Y(ST_Centroid(%1$s)) - %3$f, 2)
     LIMIT 1",
    geom_p, full_center_x, full_center_y
  ))
}

roi_half_width <- numeric_env("DBLENS_ROI_HALF_WIDTH", 120)
roi <- c(
  xmin = focus$x[[1L]] - roi_half_width,
  xmax = focus$x[[1L]] + roi_half_width,
  ymin = focus$y[[1L]] - roi_half_width,
  ymax = focus$y[[1L]] + roi_half_width
)

dbExecute(con, sprintf(
  "CREATE OR REPLACE TEMP TABLE mgl_roi_cells AS
   SELECT p.poly_ID AS cell_ID, %1$s AS geometry_raw,
          ST_X(ST_Centroid(%1$s)) AS raw_x,
          ST_Y(ST_Centroid(%1$s)) AS raw_y,
          ST_Area(%1$s) AS area
   FROM gdb_poly_cell AS p
   WHERE %1$s IS NOT NULL AND NOT ST_IsEmpty(%1$s)
     AND ST_Intersects(%1$s, ST_MakeEnvelope(%2$f, %3$f, %4$f, %5$f))",
  geom_p, roi[["xmin"]], roi[["ymin"]], roi[["xmax"]], roi[["ymax"]]
))

# -- Transcript coordinate source ---------------------------------------------
# Prefer an explicit file, otherwise use an explicit/existing DuckDB table.
local_transcript_files <- c(
  file.path(getwd(), "transcripts.parquet"),
  file.path(dirname(db_path), "transcripts.parquet")
)
local_transcript_file <- local_transcript_files[file.exists(local_transcript_files)][1L]
if (is.na(local_transcript_file)) {
  local_transcript_file <- local_transcript_files[[1L]]
}
transcript_file <- Sys.getenv(
  "DBLENS_TRANSCRIPT_FILE",
  unset = local_transcript_file
)
transcript_table <- Sys.getenv("DBLENS_TRANSCRIPT_TABLE", unset = "")

if (file.exists(transcript_file)) {
  transcript_file <- normalizePath(transcript_file, mustWork = TRUE)
  file_arg <- as.character(dbQuoteString(con, transcript_file))
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
  point_table <- point_candidates[point_candidates %in% tables][1L]
  if (is.na(point_table)) {
    stop(
      "No transcript coordinate source is available. The supplied DB has ",
      "cell-level counts but no transcript positions. Set DBLENS_TRANSCRIPT_FILE ",
      "to a Xenium transcripts.parquet/CSV export, or set ",
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
point_geom_col <- first_col(source_columns, c("geom", "geometry"))

if (is.null(x_col) || is.null(y_col)) {
  if (is.null(point_geom_col)) {
    stop(
      "Transcript source requires x/y columns (for example x_location and ",
      "y_location) or a point geometry column named geom/geometry."
    )
  }
  point_geom_type <- dbGetQuery(con, sprintf(
    "SELECT typeof(%1$s) AS type FROM %2$s WHERE %1$s IS NOT NULL LIMIT 1",
    qi(point_geom_col), transcript_relation
  ))$type[[1L]]
  point_geom_expr <- if (grepl("GEOMETRY", toupper(point_geom_type))) {
    qi(point_geom_col)
  } else {
    sprintf("ST_GeomFromWKB(%s)", qi(point_geom_col))
  }
  x_expr <- sprintf("ST_X(%s)", point_geom_expr)
  y_expr <- sprintf("ST_Y(%s)", point_geom_expr)
} else {
  x_expr <- sprintf("TRY_CAST(%s AS DOUBLE)", qi(x_col))
  y_expr <- sprintf("TRY_CAST(%s AS DOUBLE)", qi(y_col))
}

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

# Standard Xenium outputs use positive Y locations while this GiottoDB stores
# its cell polygons with negative Y. Detect that case from a source sample and
# convert transcript coordinates into the polygon coordinate system before
# cropping or joining.
sample_y <- dbGetQuery(con, sprintf(
  "SELECT %s AS y FROM %s WHERE %s IS NOT NULL LIMIT 1",
  y_expr, transcript_relation, y_expr
))$y[[1L]]
y_sign <- if (extent$ymax[[1L]] <= 0 && sample_y >= 0) -1 else 1
if (y_sign < 0) {
  message("Applying Xenium-to-GiottoDB Y inversion for transcript positions.")
}
point_y_expr <- sprintf("(%d * (%s))", y_sign, y_expr)

# Crop and materialize once so subsequent summaries and transport do not
# repeatedly scan a full molecule-level Parquet source.
dbExecute(con, sprintf(
  "CREATE OR REPLACE TEMP TABLE mgl_transcripts_xy AS
   SELECT %1$s AS transcript_ID, %2$s AS source_cell_ID,
          COALESCE(%3$s, 'unknown') AS feature_name,
          %4$s AS raw_x, %5$s AS raw_y
   FROM %6$s
   WHERE %4$s BETWEEN %7$f AND %8$f
     AND %5$s BETWEEN %9$f AND %10$f
     AND %4$s IS NOT NULL AND %5$s IS NOT NULL%11$s%12$s",
  id_expr, cell_expr, gene_expr, x_expr, point_y_expr, transcript_relation,
  roi[["xmin"]], roi[["xmax"]], roi[["ymin"]], roi[["ymax"]],
  qv_predicate, gene_predicate
))

# If Xenium cell IDs match polygon IDs, use the assignment directly. For a
# generic point table without cell IDs, retain only dots inside a cell polygon.
use_id_join <- !is.null(cell_col)
if (use_id_join) {
  n_id_matches <- dbGetQuery(con, paste(
    "SELECT COUNT(*) AS n FROM mgl_transcripts_xy AS t",
    "JOIN mgl_roi_cells AS c ON t.source_cell_ID = c.cell_ID"
  ))$n[[1L]]
  use_id_join <- n_id_matches > 0
}
point_join <- if (use_id_join) {
  "JOIN mgl_roi_cells AS c ON t.source_cell_ID = c.cell_ID"
} else {
  paste(
    "JOIN mgl_roi_cells AS c",
    "ON ST_Contains(c.geometry_raw, ST_Point(t.raw_x, t.raw_y))"
  )
}
transcript_core <- sprintf(
  "SELECT t.transcript_ID, c.cell_ID, t.feature_name,
          t.raw_x AS x, %f - t.raw_y AS y
   FROM mgl_transcripts_xy AS t %s",
  y_offset, point_join
)

n_transcripts <- dbGetQuery(
  con, sprintf("SELECT COUNT(*) AS n FROM (%s) q", transcript_core)
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
n_cells <- dbGetQuery(con, "SELECT COUNT(*) AS n FROM mgl_roi_cells")$n[[1L]]
message(
  "ROI contains ", n_cells, " cells and ",
  format(n_transcripts, big.mark = ","), " transcript dots."
)

# Hash every feature name into a fixed palette so all transcript dots are
# colored without scanning the full molecule file just to enumerate genes.
pal <- grDevices::hcl.colors(256, "Dark 3")
rgb <- grDevices::col2rgb(pal)
transcript_palette <- data.frame(
  palette_id = seq_along(pal),
  r = as.integer(rgb[1, ]), g = as.integer(rgb[2, ]), b = as.integer(rgb[3, ]),
  stringsAsFactors = FALSE
)
dbWriteTable(con, "mgl_transcript_palette", transcript_palette,
             temporary = TRUE, overwrite = TRUE)

cells <- dbGetQuery(con, sprintf(
  "WITH tr AS (%s)
   SELECT c.cell_ID, c.raw_x AS x, %f - c.raw_y AS y, c.area,
          COUNT(tr.transcript_ID) AS total_transcripts,
          COUNT(DISTINCT tr.feature_name) AS nr_genes
   FROM mgl_roi_cells AS c LEFT JOIN tr USING (cell_ID)
   GROUP BY c.cell_ID, c.raw_x, c.raw_y, c.area",
  transcript_core, y_offset
))

polygon_query <- sprintf(
  "SELECT cell_ID,
          ST_Translate(ST_Scale(geometry_raw, 1, -1), 0, %f) AS geometry
   FROM mgl_roi_cells",
  y_offset
)
transcript_query <- sprintf(
  "SELECT tr.transcript_ID, tr.cell_ID, tr.feature_name, tr.x, tr.y,
          pal.r AS r,
          pal.g AS g,
          pal.b AS b,
          220 AS a
   FROM (%s) AS tr
   LEFT JOIN mgl_transcript_palette AS pal
     ON pal.palette_id = CAST(hash(tr.feature_name) %% 256 AS INTEGER) + 1",
  transcript_core
)

# -- Linked Mosaic + deck.gl spec ---------------------------------------------
spec <- mgl_spec(
  meta = list(title = "Xenium ROI - cell polygons and transcript locations"),
  data = list(
    cells = mgl_data(type = "table", df = cells),
    polys = mgl_data(type = "duckdb", query = polygon_query, format = "geoarrow"),
    transcripts = mgl_data(type = "duckdb", query = transcript_query, format = "arrow")
  ),
  params = list(sel = list(select = "crossfilter")),
  vconcat = list(
    list(
      plot = list(list(
        mark = "rectY",
        data = list(from = "cells", filterBy = "$sel"),
        x = list(bin = "total_transcripts"), y = list(count = NULL),
        fill = "#60a5fa"
      ), list(
        select = "intervalX", as = "$sel",
        brush = list(stroke = "currentColor", fill = "transparent")
      )),
      width = 720, height = 90, yAxis = NULL,
      marginLeft = 40, marginRight = 0, marginTop = 0, marginBottom = 18
    ),
    list(hconcat = list(
      mgl_deckgl(
        id = "transcript-spatial", filter_by = "$sel",
        width = 600, height = 500,
        layers = list(
          list(
            `@@type` = "GeoArrowPolygonLayer", id = "cells-polygons",
            data = "polys", geometryColumn = "geometry",
            getFillColor = c(157L, 78L, 221L, 38L),
            stroked = FALSE,
            coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
            positionFormat = "XY", pickable = TRUE
          ),
          list(
            `@@type` = "ScatterplotLayer", id = "transcripts",
            data = "transcripts", getPosition = "@@=[x, y]",
            getFillColor = "@@=[r, g, b, a]",
            # Radius is in spatial units: dots are tiny until the user zooms in.
            getRadius = 0.28, radiusUnits = "common", radiusMinPixels = 0,
            coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
            positionFormat = "XY", opacity = 0.9, pickable = FALSE
          ),
          list(
            `@@type` = "ScatterplotLayer", id = "cell-centroids",
            data = "cells", getPosition = "@@=[x, y]",
            getFillColor = c(15L, 23L, 42L, 190L),
            getRadius = 1.2, radiusUnits = "pixels",
            coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
            positionFormat = "XY", opacity = 0.8, pickable = TRUE
          )
        )
      ),
      list(
        plot = list(list(
          mark = "rectX", data = list(from = "cells", filterBy = "$sel"),
          x = list(count = NULL), y = list(bin = "nr_genes"),
          fill = "#34d399"
        ), list(
          select = "intervalY", as = "$sel",
          brush = list(stroke = "currentColor", fill = "transparent")
        )),
        width = 110, height = 500, xAxis = NULL,
        marginTop = 0, marginLeft = 0, marginRight = 0, marginBottom = 18
      )
    )),
    list(
      input = "table", from = "cells", filterBy = "$sel",
      columns = c("cell_ID", "area", "total_transcripts", "nr_genes"),
      width = 720, height = 180
    )
  )
)

viewer <- mosaic_gl(spec, con = con, width = "100%", height = 850)
print(viewer)
