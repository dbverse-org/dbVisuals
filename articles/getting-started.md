# Getting Started with dbVisuals

## Introduction

dbVisuals is a minimal
[REPL](https://en.wikipedia.org/wiki/Read%E2%80%93eval%E2%80%93print_loop)
and visualization UI built on [SQLRooms](https://sqlrooms.org/) for
interactive for interactive exploration of
[dbverse](https://github.com/dbverse-org) objects.

### dbVisuals features

- **Dropzone** - Drag and drop files directly into the UI for
  exploration
- **SQL Editor** - Run queries on database-backed objects
- **R Console** - Execute R code interactively
- **Hardware-accelerated Visualizations** - High-performance WebGL
  spatial rendering using [deck.gl](https://deck.gl/)
- **Interactive Linked Views** - Create interactive linked
  visualizations using [Mosaic specs](https://github.com/uwdata/mosaic)
- **Live Connection** - Call the UI from R
- **Smart Chart Builder** - Easily create charts based on common data in
  your database

### Installation

``` r

# Install from GitHub
devtools::install_github("dbverse-org/dbVisuals2", subdir = "r-package")

# Optional: Install all recommended dependencies
library(dbVisuals)
install_dbvisuals_deps()
```

dbVisuals automatically provides access to:

- [rDeckgl](https://github.com/TiRizvanov/rDeckgl) - R interface to
  deck.gl for WebGL visualizations
- [rMosaic](https://github.com/TiRizvanov/rMosaic) - R interface to
  Mosaic for interactive linked views

### Quick Start

#### Launch with In-Memory Database

The simplest way to start is with an empty in-memory database:

``` r

library(dbVisuals)

# Launch dbVisuals with an empty database
dashboard <- launchBrowser()
```

#### Launch with GiottoDB Database

For spatial data analysis, connect to a GiottoDB database from (Giotto
Suite)\[<https://giottosuite.com>\]

``` r

library(dbVisuals)
library(GiottoDB)
library(GiottoData)
library(duckdb)

# Create a GiottoDB database
gobject <- loadGiottoMini("visium")
con <- dbConnect(duckdb(), dbdir = "my_spatial_data.duckdb")
gobject_db <- as_giottodb(gobject, con = con, temporary = FALSE)
dbDisconnect(con, shutdown = TRUE)

# Launch dbVisuals
dashboard <- launchBrowser(db_path = "my_spatial_data.duckdb")

# Explore your spatial data with SQL queries and visualizations
```

#### Cleanup

When you’re done, clean up the background processes:

``` r

stop_sqlrooms(dashboard)
```

### What You Can Do in dbVisuals

#### 1. SQL Queries on Spatial Data

Run SQL queries directly on your GiottoDB tables:

``` sql
-- Query your GiottoDB tables
SELECT * FROM gdb_cell_rna_raw LIMIT 10;

-- Aggregate spatial expression data
SELECT cell_ID, COUNT(*) as gene_count
FROM gdb_cell_rna_normalized
GROUP BY cell_ID;

-- Spatial polygon queries
SELECT poly_ID, ST_Area(geom) as area
FROM gdb_poly_cell;
```

#### 2. R Code Execution

Execute R code directly in dbVisuals cells:

``` r

# Inside dbVisuals R cell:

# Load packages
library(GiottoDB)
library(duckdb)

# Query and analyze
con <- dbConnect(duckdb(), "my_spatial_data.duckdb")
data <- dbReadTable(con, "gdb_cell_rna_raw")
summary(data)

# Export results back to dbVisuals
result_df <- some_analysis(data)
sqlrooms_export_table("analysis_results", result_df)
```

#### 3. Interactive Visualizations

Create deck.gl and Mosaic visualizations using the built-in tools in
dbVisuals.

### Advanced Configuration

#### Custom Ports

Specify custom ports if defaults are in use:

``` r

dashboard <- launchBrowser(
  db_path = "my_data.duckdb",
  port = 3002,           # R server port
  frontend_port = 5174,  # Frontend port
  browser = TRUE         # Auto-open browser
)
```

#### Multiple Instances

Run multiple dbVisuals instances with different databases:

``` r

# Instance 1
dashboard1 <- launchBrowser(
  db_path = "project1.duckdb",
  port = 3001,
  frontend_port = 5173
)

# Instance 2 (different ports)
dashboard2 <- launchBrowser(
  db_path = "project2.duckdb",
  port = 3002,
  frontend_port = 5174
)
```

### Troubleshooting

#### Ports Already in Use

If you see connection errors, try different ports:

``` r

launchBrowser(port = 3002, frontend_port = 5174)
```

#### Missing Dependencies

Install recommended packages for full functionality:

``` r

install_dbvisuals_deps()
```

Or manually:

``` r

install.packages(c("DBI", "duckdb", "shiny"))
devtools::install_github("TiRizvanov/rDeckgl")
devtools::install_github("TiRizvanov/rMosaic")
```

### Next Steps

- Explore the function reference:
  [`?launchBrowser`](https://dbverse-org.github.io/dbVisuals2/reference/launchBrowser.md)
- Learn about data export:
  [`?sqlrooms_export_table`](https://dbverse-org.github.io/dbVisuals2/reference/sqlrooms_export_table.md)
- Check out GiottoDB for spatial omics analysis: [GiottoDB
  documentation](https://github.com/dbverse-org/GiottoDB)
- Report issues: [GitHub
  Issues](https://github.com/dbverse-org/dbVisuals2/issues)
