# dbVisuals demo 1 — in-situ deck.gl plot with linked Mosaic marginals + table.
#
# Spec is written in the SAME native Mosaic format as the protein-design-explorer
# / taxi-crossfilter / gaia-stars vignettes. The only addition is the
# input = "deckgl" node — handled by dbVisuals's custom Mosaic input. parseSpec +
# astToDOM produces the actual Mosaic chrome (concat layout, margins, brush
# styling), with a Deck instance embedded in the slot.

suppressPackageStartupMessages({
  library(DBI)
  library(duckdb)
  library(dbVisuals)
})

# Path to a GiottoDB DuckDB file with a polygon table such as
# `gdb_poly_cell(poly_ID, geom)` or the zoom-level tables used in this repo.
# Override with the DBLENS_DEMO_DB env var, or set the variable below.
db_path <- Sys.getenv(
  "DBLENS_DEMO_DB",
  unset = "WTA_Preview_FFPE_Breast_Cancer_xenium.duckdb"
)
if (!file.exists(db_path)) {
  stop("Demo DB not found at '", db_path,
       "'. Set DBLENS_DEMO_DB or edit db_path at the top of this script.")
}
db_path <- normalizePath(db_path, mustWork = TRUE)
con <- dbConnect(duckdb(), dbdir = db_path)

for (sql in c(
  "INSTALL spatial", "LOAD spatial",
  "INSTALL nanoarrow FROM community", "LOAD nanoarrow",
  "CALL register_geoarrow_extensions()"
)) try(dbExecute(con, sql), silent = TRUE)

polygon_table <- {
  candidates <- c("gdb_poly_cell", "gdb_poly_z0", "gdb_poly_z1")
  matches <- intersect(candidates, DBI::dbListTables(con))
  if (length(matches) < 1) {
    stop(
      "Demo DB must contain one of: ",
      paste(candidates, collapse = ", ")
    )
  }
  matches[[1]]
}
polygon_ident <- as.character(DBI::dbQuoteIdentifier(con, polygon_table))

# Detect geom encoding (GEOMETRY vs WKB blob) and compute Y-flip offset
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

# Centroids + per-cell metadata for the marginal histograms.
centroids <- dbGetQuery(con, sprintf(
  "SELECT poly_ID AS cell_ID,
          ST_X(ST_Centroid(%s)) AS x,
          %f - ST_Y(ST_Centroid(%s)) AS y,
          ST_Area(%s) AS area
   FROM %s
    WHERE %s IS NOT NULL AND NOT ST_IsEmpty(%s)",
  geom_expr, y_offset, geom_expr, geom_expr, polygon_ident, geom_expr, geom_expr))
db_tables <- DBI::dbListTables(con)
rna_table <- switch(
  polygon_table,
  gdb_poly_z0 = if ("gdb_z0_rna_raw" %in% db_tables) "gdb_z0_rna_raw" else NULL,
  gdb_poly_z1 = if ("gdb_z1_rna_raw" %in% db_tables) "gdb_z1_rna_raw" else NULL,
  gdb_poly_aggregate = if ("gdb_aggregate_rna_raw" %in% db_tables) "gdb_aggregate_rna_raw" else NULL,
  NULL
)

if (!is.null(rna_table) && "features" %in% db_tables) {
  polygon_ident <- as.character(DBI::dbQuoteIdentifier(con, polygon_table))
  rna_ident <- as.character(DBI::dbQuoteIdentifier(con, rna_table))
  cell_stats <- dbGetQuery(con, sprintf(
    "WITH polys AS (
       SELECT row_number() OVER () AS j, poly_ID AS cell_ID
       FROM %s
     ),
     feats AS (
       SELECT row_number() OVER () AS i, feat_ID
       FROM features
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
                  PARTITION BY cell_ID
                  ORDER BY expr DESC, feat_ID
                ) AS rn
         FROM gene_cell
       )
       WHERE rn = 1
     )
     SELECT s.cell_ID,
            s.total_expr,
            s.nr_feats,
            COALESCE(d.cluster, 'unassigned') AS cluster
     FROM (
       SELECT cell_ID,
              SUM(expr) AS total_expr,
              COUNT(*) AS nr_feats
       FROM gene_cell
       GROUP BY 1
     ) AS s
     LEFT JOIN dominant AS d USING (cell_ID)",
    polygon_ident, rna_ident
  ))
  centroids <- merge(centroids, cell_stats, by = "cell_ID", all.x = TRUE, sort = FALSE)
  centroids$total_expr[is.na(centroids$total_expr)] <- 0
  centroids$nr_feats[is.na(centroids$nr_feats)] <- 0
  centroids$cluster[is.na(centroids$cluster)] <- "unassigned"
} else {
  set.seed(1)
  centroids$total_expr <- pmax(0, round(rnorm(nrow(centroids), 200, 80)))
  centroids$nr_feats   <- pmax(0, round(rnorm(nrow(centroids), 30, 10)))
  centroids$cluster    <- paste0("c", sample.int(8L, nrow(centroids), TRUE))
}

pal <- grDevices::hcl.colors(length(unique(centroids$cluster)), "Dark 3")
rgb_ <- grDevices::col2rgb(pal[as.integer(factor(centroids$cluster))])
centroids$r <- as.integer(rgb_[1, ])
centroids$g <- as.integer(rgb_[2, ])
centroids$b <- as.integer(rgb_[3, ])

polygon_alpha <- as.integer(round(0.42 * 255))

# Send native DuckDB geometry as a geometry column. dbVisuals detects this
# `cell_ID` + `geometry` result shape, transports polygon WKB as a compact
# binary envelope, and renders it through deck.gl's binary SolidPolygonLayer.
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

# ── Native Mosaic spec (mirrors protein-design-explorer.Rmd shape) ──────────
spec <- mgl_spec(
  meta = list(title = "Xenium WTA — in-situ + linked marginals"),
  data = list(
    cells = mgl_data(type = "table",  df = centroids),
    polys = mgl_data(type = "duckdb", query = polygon_query, format = "geoarrow")
  ),
  params = list(
    sel = list(select = "crossfilter")
  ),
  vconcat = list(
    # Top marginal histogram for total_expr.
    list(
      plot = list(list(
        mark = "rectY",
        data = list(from = "cells", filterBy = "$sel"),
        x = list(bin = "total_expr"),
        y = list(count = NULL),
        fill = "#60a5fa"
      ), list(
        select = "intervalX", as = "$sel",
        brush = list(stroke = "currentColor", fill = "transparent")
      )),
      width = 720, height = 90,
      yAxis = NULL,
      marginLeft = 40, marginRight = 0, marginTop = 0, marginBottom = 18
    ),
    # Main row: deck.gl spatial + right marginal histogram (nr_feats).
    list(hconcat = list(
      mgl_deckgl(
        id        = "spatial",
        filter_by = "$sel",
        width     = 600, height = 480,
        layers = list(
          list(
            `@@type`       = "GeoArrowPolygonLayer",
            id             = "polys",
            data           = "polys",
            geometryColumn = "geometry",
            getFillColor   = c(157L, 78L, 221L, polygon_alpha),
            stroked        = FALSE,
            getLineColor   = c(40L, 30L, 80L, 180L),
            lineWidthMinPixels = 0.4,
            coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
            positionFormat = "XY",
            pickable       = TRUE
          ),
          list(
            `@@type`     = "ScatterplotLayer",
            id           = "centroids",
            data         = "cells",
            getPosition  = "@@=[x, y]",
            getFillColor = "@@=[r, g, b]",
            getRadius    = 1.2,
            radiusUnits  = "pixels",
            coordinateSystem = "@@#COORDINATE_SYSTEM.CARTESIAN",
            positionFormat = "XY",
            opacity      = 0.75,
            pickable     = TRUE
          )
        )
      ),
      list(
        plot = list(list(
          mark = "rectX",
          data = list(from = "cells", filterBy = "$sel"),
          x = list(count = NULL),
          y = list(bin = "nr_feats"),
          fill = "#34d399"
        ), list(
          select = "intervalY", as = "$sel",
          brush = list(stroke = "currentColor", fill = "transparent")
        )),
        width = 110, height = 480,
        xAxis = NULL,
        marginTop = 0, marginLeft = 0, marginRight = 0, marginBottom = 18
      )
    )),
    # Selection-driven table at the bottom.
    list(
      input    = "table",
      from     = "cells",
      filterBy = "$sel",
      columns  = c("cell_ID", "cluster", "area", "total_expr", "nr_feats"),
      width    = 720, height = 220
    )
  )
)

viewer <- mosaic_gl(spec, con = con, width = "100%", height = 850)
print(viewer)
