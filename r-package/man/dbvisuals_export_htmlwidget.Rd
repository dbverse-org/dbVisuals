% Please edit documentation in R/htmlwidget_export.R
\name{dbvisuals_export_htmlwidget}
\alias{dbvisuals_export_htmlwidget}
\alias{export_htmlwidget}
\title{Export a dbVisuals spec as an htmlwidget}
\usage{
dbvisuals_export_htmlwidget(
  spec,
  file,
  engine = "auto",
  data = NULL,
  data_sql = NULL,
  data_name = "agent_data",
  con = NULL,
  db_path = NULL,
  project = NULL,
  selfcontained = FALSE,
  data_transport = "file",
  width = NULL,
  height = NULL
)

export_htmlwidget(...)
}
\arguments{
\item{spec}{A widget specification as an R list, JSON string, JSON file path,
or an existing htmlwidget. Mosaic specs are rendered with \code{rMosaic};
deck.gl specs are rendered with \code{rDeckgl}.}

\item{file}{Output HTML file path.}

\item{engine}{Export target. \code{"auto"} infers from the spec shape;
\code{"rMosaic"} and \code{"rDeckgl"} select the R package explicitly.
\code{"mosaic"} and \code{"deckgl"} are accepted aliases.}

\item{data}{Optional named list of data.frames to register for the widget.}

\item{data_sql}{Optional SQL query to fetch from \code{con}, \code{db_path},
\code{project}, or the active SQLRooms database and register as
\code{data_name}.}

\item{data_name}{Name used when registering \code{data_sql} results.}

\item{con}{Optional DBI connection used for \code{data_sql} or direct DuckDB
data nodes in an rDeckgl spec.}

\item{db_path}{Optional DuckDB database path used to open a temporary read-only
connection for export.}

\item{project}{Optional dbProject object or DBI connection.}

\item{selfcontained}{Passed to \code{\link[htmlwidgets:saveWidget]{htmlwidgets::saveWidget()}}.
Defaults to \code{FALSE} so large exports can keep dependencies and Arrow
payloads as files.}

\item{data_transport}{Data transport passed to \code{rMosaic::mosaic()} or
\code{rDeckgl::deckgl()}. Defaults to \code{"file"} to avoid base64 Arrow
payloads in JSON.}

\item{width, height}{Optional widget dimensions.}

\item{...}{Arguments passed to \code{dbvisuals_export_htmlwidget()}.}
}
\value{
Invisibly returns a list describing the exported file, engine, dependency
directory, and generated data files.
}
\description{
Renders a Mosaic or deck.gl specification through \code{rMosaic} or
\code{rDeckgl} and saves the resulting htmlwidget to disk. This is intended for
durable exports from dbVisuals specs; the live dbVisuals workspace continues to
use the SQLRooms React runtime.
}
\examples{
\dontrun{
spec <- list(
  plot = list(list(
    mark = "dot",
    data = list(from = "cells"),
    x = "x",
    y = "y"
  ))
)
dbvisuals_export_htmlwidget(
  spec,
  "scatter.html",
  engine = "rMosaic",
  data = list(cells = data.frame(x = 1:10, y = 1:10))
)
}
}
