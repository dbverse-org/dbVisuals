# dbVisuals demo 2 - in-situ plot + interactive ROI zoom inset.
#
# Data pipeline is identical to 01_in_situ_with_marginals.R (auto-detect
# polygon table, real RNA metrics with synthetic fallback, flat purple polygon
# fill). The layout is a single deck.gl panel with a zoom inset overlaid
# absolutely in the top-right corner.
#
# Visual design matches the publication figure in paper/outputs/examples:
#   - White background
#   - Red rectangle marks the ROI on the full-tissue panel
#   - Red connecting lines run from the ROI's right corners to the inset's
#     left corners
#   - Only pan / zoom / fit controls are shown (lasso tools hidden)
#
# Interaction: click the "select" button in the toolbar, then drag a rectangle
# on the full-tissue view to choose a new ROI. The zoom inset and connecting
# lines update automatically.

suppressPackageStartupMessages({
  library(DBI)
  library(duckdb)
  library(dbVisuals)
})

# -- 1. DB connection (same as 01) ---------------------------------------------
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

# -- 3. Initial ROI (20%% box centred on data - drag to replace interactively) -
ext <- list(
  xmin = min(centroids$x), xmax = max(centroids$x),
  ymin = min(centroids$y), ymax = max(centroids$y)
)
roi_frac <- 0.20
cx     <- 0.5 * (ext$xmin + ext$xmax)
cy     <- 0.5 * (ext$ymin + ext$ymax)
half_w <- 0.5 * roi_frac * (ext$xmax - ext$xmin)
half_h <- 0.5 * roi_frac * (ext$ymax - ext$ymin)
roi <- list(
  xmin = cx - half_w, xmax = cx + half_w,
  ymin = cy - half_h, ymax = cy + half_h
)

# -- 4. Zoom panel initial view state ------------------------------------------
main_panel_px <- 700
zoom_panel_px <- 290
roi_w    <- roi$xmax - roi$xmin
roi_h    <- roi$ymax - roi$ymin
roi_zoom <- log2(zoom_panel_px / (max(roi_w, roi_h) * 1.10))
roi_cx   <- 0.5 * (roi$xmin + roi$xmax)
roi_cy   <- 0.5 * (roi$ymin + roi$ymax)

# -- 5. Mosaic spec - single main panel + zoom inset ---------------------------
# The ROI rectangle and connecting lines are drawn as an SVG overlay in JS
# so they project correctly as the user pans/zooms the main view.
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
    pickable         = FALSE
  )
}

spec <- mgl_spec(
  meta = list(title = "Xenium WTA — in-situ + ROI zoom inset"),
  data = list(
    cells = mgl_data(type = "table",  df = centroids),
    polys = mgl_data(
      type = "duckdb", query = polygon_query, format = "geoarrow"
    )
  ),
  hconcat = list(
    mgl_deckgl(
      id     = "main",
      width  = main_panel_px, height = main_panel_px,
      title  = "Full tissue",
      layers = list(polygon_layer, scatter_layer(1.2))
    ),
    mgl_deckgl(
      id     = "zoom",
      width  = zoom_panel_px, height = zoom_panel_px,
      title  = "Zoom: ROI",
      initialViewState = list(
        target = list(roi_cx, roi_cy, 0),
        zoom   = roi_zoom
      ),
      layers = list(polygon_layer, scatter_layer(2.0))
    )
  )
)

# -- 6. Render + post-processing -----------------------------------------------
# ROI coords and data extents are injected as JS literals so the onRender
# callback can project them and set up the drag-to-select handler.
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

viewer <- mosaic_gl(spec, con = con,
                    width  = main_panel_px + 40,
                    height = main_panel_px + 60)

# nolint start: line_length_linter.
js_template <- '
function(el, x) {
  var ROI      = __ROI__;
  var DATA_EXT = __EXT__;
  var ZOOM     = __ZOOM__;
  var RED      = "#dc1c1c";
  var ZOOM_PAD = 1.10;

  var tries = 0;
  function setup() {
    var slots = el.querySelectorAll(".mosaic_gl-deckgl-slot");
    if (slots.length < 2) {
      if (++tries > 100) { console.warn("[02] deckgl slots not found"); return; }
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

    // Viewer toolbars are mounted asynchronously (after deck.gl panel
    // finishes rendering). Hide any that exist now, and watch for new ones.
    function hideAllToolbars() {
      el.querySelectorAll(".mosaic_gl-toolbar").forEach(function(t) {
        t.style.display = "none";
      });
    }
    hideAllToolbars();
    var toolbarObserver = new MutationObserver(hideAllToolbars);
    toolbarObserver.observe(el, { childList: true, subtree: true });

    // Floating "select" toggle — added directly to mainSlot, not the toolbar.
    var inSelectMode = false;
    var selBtn = document.createElement("button");
    selBtn.type = "button";
    selBtn.textContent = "select";
    selBtn.style.cssText =
      "position:absolute;top:8px;left:8px;z-index:30;padding:3px 10px" +
      ";font-size:12px;font-weight:600;cursor:pointer;color:#dc1c1c" +
      ";background:#ffffff;border:1.5px solid #dc1c1c;border-radius:3px" +
      ";box-shadow:0 1px 3px rgba(0,0,0,0.15)";
    mainSlot.appendChild(selBtn);
    selBtn.addEventListener("click", function() {
      inSelectMode = !inSelectMode;
      selectDiv.style.display = inSelectMode ? "block" : "none";
      selBtn.style.outline    = inSelectMode ? ("2px solid " + RED) : "";
      selBtn.style.fontWeight = inSelectMode ? "bold" : "";
    });

    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%" +
      ";pointer-events:none;z-index:5;overflow:visible";
    mainSlot.appendChild(svg);

    var selectDiv = document.createElement("div");
    selectDiv.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:100%" +
      ";z-index:8;cursor:crosshair;display:none";
    mainSlot.appendChild(selectDiv);

    var dragSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    dragSvg.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none";
    selectDiv.appendChild(dragSvg);
    var dragRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    dragRect.setAttribute("fill",         "rgba(220,28,28,0.08)");
    dragRect.setAttribute("stroke",       RED);
    dragRect.setAttribute("stroke-width", "4");
    dragRect.setAttribute("stroke-linejoin", "round");
    dragSvg.appendChild(dragRect);

    function findDeck(slot) {
      // 1. Direct property on canvas/board (set by patched mosaic_gl bundle)
      var found = null;
      slot.querySelectorAll("*").forEach(function(e) {
        if (!found && e.__deckInstance) found = e.__deckInstance;
      });
      if (found) return found;
      // 2. Fall back to scanning window.__mosaic_glInstances registry
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

    function unproject(deck, sx, sy) {
      if (deck) {
        var vps = deck.getViewports && deck.getViewports();
        if (vps && vps.length) {
          var p = vps[0].unproject([sx, sy]);
          if (p && isFinite(p[0])) return p;
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
      // Connect matching corners. Note: data y is flipped (y_offset - ST_Y),
      // so the data-coord names invert on screen:
      //   bl (xmin,ymax) -> visual top-left
      //   tr (xmax,ymin) -> visual bottom-right
      line(bl[0], bl[1], zL, zT);   // visual top-left      -> zoom top-left
      line(tr[0], tr[1], zR, zB);   // visual bottom-right  -> zoom bottom-right
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

    var dragStart = null;
    selectDiv.addEventListener("mousedown", function(e) {
      var r = selectDiv.getBoundingClientRect();
      dragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
      dragRect.setAttribute("x", dragStart.x); dragRect.setAttribute("y", dragStart.y);
      dragRect.setAttribute("width", 0);        dragRect.setAttribute("height", 0);
      e.preventDefault();
    });
    selectDiv.addEventListener("mousemove", function(e) {
      if (!dragStart) return;
      var r  = selectDiv.getBoundingClientRect();
      var cx = e.clientX - r.left, cy = e.clientY - r.top;
      dragRect.setAttribute("x",      Math.min(dragStart.x, cx));
      dragRect.setAttribute("y",      Math.min(dragStart.y, cy));
      dragRect.setAttribute("width",  Math.abs(cx - dragStart.x));
      dragRect.setAttribute("height", Math.abs(cy - dragStart.y));
    });
    selectDiv.addEventListener("mouseup", function(e) {
      if (!dragStart) return;
      var r  = selectDiv.getBoundingClientRect();
      var cx = e.clientX - r.left, cy = e.clientY - r.top;
      var sx = Math.min(dragStart.x, cx), sy = Math.min(dragStart.y, cy);
      var sw = Math.abs(cx - dragStart.x), sh = Math.abs(cy - dragStart.y);
      dragStart = null;
      dragRect.setAttribute("width", 0); dragRect.setAttribute("height", 0);

      if (sw < 8 || sh < 8) return;

      var deck = findDeck(mainSlot);
      var p1   = unproject(deck, sx,      sy);
      var p2   = unproject(deck, sx + sw, sy + sh);
      ROI = {
        xmin: Math.min(p1[0], p2[0]), xmax: Math.max(p1[0], p2[0]),
        ymin: Math.min(p1[1], p2[1]), ymax: Math.max(p1[1], p2[1])
      };

      var zoomDeck = findDeck(zoomSlot);
      if (zoomDeck) {
        // Compute zoom so the ROI fits the zoom panel (ZOOM.px),
        // accounting for the actual current zoom panel pixel size.
        var zoomPx = (zoomSlot.clientWidth && zoomSlot.clientHeight)
          ? Math.min(zoomSlot.clientWidth, zoomSlot.clientHeight)
          : ZOOM.px;
        var newRoiW = ROI.xmax - ROI.xmin, newRoiH = ROI.ymax - ROI.ymin;
        var newZoom = Math.log2(zoomPx / (Math.max(newRoiW, newRoiH) * ZOOM_PAD));
        var newVS = {
          target: [0.5*(ROI.xmin+ROI.xmax), 0.5*(ROI.ymin+ROI.ymax), 0],
          zoom:   newZoom,
          transitionDuration: 400
        };
        // Prefer the patched setViewState() helper (controlled view state),
        // fall back to setProps for older bundles.
        var zoomPanel = null;
        zoomSlot.querySelectorAll("*").forEach(function(e) {
          if (!zoomPanel && e.__mosaic_glPanel) zoomPanel = e.__mosaic_glPanel;
        });
        if (zoomPanel && typeof zoomPanel.setViewState === "function") {
          zoomPanel.setViewState(newVS);
        } else {
          try { zoomDeck.setProps({ viewState: newVS }); } catch (err) {}
          try { zoomDeck.setProps({ initialViewState: newVS }); } catch (err) {}
        }
      }

      inSelectMode = false;
      selectDiv.style.display = "none";
      selBtn.style.outline    = "";
      selBtn.style.fontWeight = "";

      lastTl = null;
    });

    setTimeout(function() { rafLoop(); }, 600);
  }

  setup();
}
'
js_code <- gsub("__ROI__",    roi_js,                      js_template, fixed = TRUE)
js_code <- gsub("__EXT__",    ext_js,                      js_code,     fixed = TRUE)
js_code <- gsub("__ZOOM__",   zoom_js,                     js_code,     fixed = TRUE)
js_code <- gsub("__WPANEL__", as.character(main_panel_px), js_code,     fixed = TRUE)
viewer <- htmlwidgets::onRender(viewer, js_code)
# nolint end

print(viewer)
