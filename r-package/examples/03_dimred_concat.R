# dbVisuals demo 2 — UMAP / PCA dim-pair concat (1v2, 1v3, 2v3) linked to a
# Mosaic categorical bar of leiden_clus + a selection-driven table.
#
# Spec uses native Mosaic vconcat / hconcat / plot / input nodes, exactly like
# Mosaic/rMosaic/vignettes/taxi-crossfilter.Rmd. The deck.gl panels are
# rendered as input = "deckgl" with a `concat` block that fans out the layer
# spec over N (x, y) pairs.

suppressPackageStartupMessages({
  library(GiottoData)
  library(Giotto)
  library(DBI)
  library(duckdb)
  library(dbVisuals)
})

gobject <- GiottoData::loadGiottoMini("visium", verbose = FALSE)
gobject <- Giotto::runPCA (gobject, scale_unit = TRUE, center = TRUE)
gobject <- Giotto::runUMAP(gobject, dimensions_to_use = 1:10, n_components = 3)

# Pull cells + UMAP/PCA dims + leiden_clus into one wide data.frame, exactly
# like demo 02_dimred_concat — metadata lives on the giotto object, dim reds
# are accessed via getDimReduction.
md   <- Giotto::pDataDT(gobject, spat_unit = "cell", feat_type = "rna")
umap <- Giotto::getDimReduction(gobject, reduction_method = "umap",
                                  name = "umap", output = "matrix")
pca  <- Giotto::getDimReduction(gobject, reduction_method = "pca",
                                  name = "pca",  output = "matrix")
stopifnot(identical(rownames(umap), rownames(pca)))
cells <- data.frame(
  cell_ID = rownames(umap),
  umap_1  = umap[, 1], umap_2 = umap[, 2], umap_3 = umap[, 3],
  pca_1   = pca[, 1],  pca_2  = pca[, 2],  pca_3  = pca[, 3],
  stringsAsFactors = FALSE
)
cells <- merge(cells, as.data.frame(md), by = "cell_ID",
               all.x = TRUE, sort = FALSE)
cells$leiden_clus <- as.character(cells$leiden_clus)

spec <- mgl_spec(
  meta = list(title = "UMAP / PCA dim pairs — linked to leiden_clus"),
  data = list(cells = mgl_data(type = "table", df = cells)),
  params = list(
    sel = list(select = "crossfilter")
  ),
  vconcat = list(

    # 1. Mosaic categorical bar of leiden_clus (cross-filter source).
    list(
      plot = list(list(
        mark = "barY",
        data = list(from = "cells", filterBy = "$sel"),
        x = "leiden_clus",
        y = list(count = NULL),
        fill = "#60a5fa"
      ), list(
        select = "toggleX", as = "$sel"
      )),
      width = 700, height = 150,
      marginLeft = 40
    ),

    # 2. UMAP dim-pair concat (deck.gl).
    mgl_deckgl(
      id        = "umap-concat",
      filter_by = "$sel",
      width     = 720, height = 220,
      concat = list(orient = "hconcat", panes = list(
        list(x = "umap_1", y = "umap_2", title = "UMAP 1 vs 2"),
        list(x = "umap_1", y = "umap_3", title = "UMAP 1 vs 3"),
        list(x = "umap_2", y = "umap_3", title = "UMAP 2 vs 3")
      )),
      layers = list(list(
        `@@type`     = "ScatterplotLayer",
        id           = "p",
        data         = "cells",
        getFillColor = c(100L, 180L, 255L, 220L),
        getRadius    = 3,
        radiusUnits  = "pixels",
        opacity      = 0.85,
        pickable     = TRUE
      ))
    ),

    # 3. PCA dim-pair concat (deck.gl).
    mgl_deckgl(
      id        = "pca-concat",
      filter_by = "$sel",
      width     = 720, height = 220,
      concat = list(orient = "hconcat", panes = list(
        list(x = "pca_1", y = "pca_2", title = "PC 1 vs 2"),
        list(x = "pca_1", y = "pca_3", title = "PC 1 vs 3"),
        list(x = "pca_2", y = "pca_3", title = "PC 2 vs 3")
      )),
      layers = list(list(
        `@@type`     = "ScatterplotLayer",
        id           = "p",
        data         = "cells",
        getFillColor = c(245L, 158L, 11L, 220L),
        getRadius    = 3,
        radiusUnits  = "pixels",
        opacity      = 0.85,
        pickable     = TRUE
      ))
    ),

    # 4. Mosaic table of the currently selected cells.
    list(
      input    = "table",
      from     = "cells",
      filterBy = "$sel",
      columns  = c("cell_ID", "leiden_clus", "umap_1", "umap_2", "umap_3",
                   "pca_1", "pca_2", "nr_feats", "total_expr"),
      width    = 720, height = 220
    )
  )
)

viewer <- mosaic_gl(spec, height = 900)
print(viewer)
