#' Install Complete dbVisuals Dependencies
#'
#' Installs all recommended dependencies for dbVisuals to enable full SQL Rooms
#' functionality. Everything comes from CRAN: the database packages (DBI,
#' duckdb) and the visualization backends (rDeckgl, rMosaic).
#'
#' @details
#' This function installs, all from CRAN:
#' \itemize{
#'   \item DBI, duckdb
#'   \item rDeckgl, rMosaic
#' }
#'
#' The function checks which packages are already installed and only installs
#' missing ones. In interactive sessions the user is asked to confirm before any
#' installation starts; in non-interactive sessions the function aborts with a
#' message.
#'
#' @param ask Logical. Ask the user for confirmation before installing.
#'   Defaults to `TRUE`: interactive sessions are prompted, and
#'   non-interactive sessions install nothing unless the caller passes
#'   `ask = FALSE` explicitly.
#'
#' @return Invisibly returns `TRUE` if all installations succeeded, `FALSE`
#'   otherwise (e.g., the user declined, or a non-interactive session).
#'
#' @export
#' @examples
#' \dontrun{
#' # Install all recommended dependencies after confirming the prompt
#' install_dbvisuals_deps()
#'
#' # Skip the prompt (e.g. inside an automated environment)
#' install_dbvisuals_deps(ask = FALSE)
#' }
install_dbvisuals_deps <- function(ask = TRUE) {
  # rDeckgl and rMosaic are on CRAN, so nothing here needs a GitHub remote.
  cran_pkgs <- c("DBI", "duckdb", "rDeckgl", "rMosaic")

  missing_cran <- cran_pkgs[
    !vapply(cran_pkgs, requireNamespace, logical(1L), quietly = TRUE)
  ]

  message(
    "install_dbvisuals_deps() will install the following packages from CRAN:\n",
    "  ",
    if (length(missing_cran)) {
      paste(missing_cran, collapse = ", ")
    } else {
      "(all installed)"
    },
    "\n"
  )

  if (isTRUE(ask)) {
    if (!interactive()) {
      message(
        "Non-interactive session and ask = TRUE; not installing. ",
        "Call install_dbvisuals_deps(ask = FALSE) to proceed."
      )
      return(invisible(FALSE))
    }
    answer <- tolower(trimws(readline("Proceed with installation? [y/N]: ")))
    if (!answer %in% c("y", "yes")) {
      message("Aborted; no packages installed.")
      return(invisible(FALSE))
    }
  }

  if (length(missing_cran) > 0) {
    message("Installing from CRAN: ", paste(missing_cran, collapse = ", "))
    utils::install.packages(missing_cran)
  } else {
    message("All dependencies already installed.")
  }

  message("\n\u2713 dbVisuals dependencies installation complete!")
  invisible(TRUE)
}
