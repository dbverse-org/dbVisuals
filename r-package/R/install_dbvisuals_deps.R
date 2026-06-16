#' Install Complete dbVisuals Dependencies
#'
#' Installs all recommended dependencies for dbVisuals to enable full SQL Rooms
#' functionality. This installs database packages (DBI, duckdb) from CRAN, and
#' the optional visualization packages (rDeckgl, rMosaic) from GitHub.
#'
#' @details
#' This function installs:
#' \itemize{
#'   \item CRAN packages: DBI, duckdb
#'   \item GitHub packages: rDeckgl, rMosaic (from TiRizvanov)
#' }
#'
#' The function checks which packages are already installed and only installs
#' missing ones. Requires the 'remotes' package for GitHub installations. In
#' interactive sessions the user is asked to confirm before any installation
#' starts; in non-interactive sessions the function aborts with a message.
#'
#' @param ask Logical. Ask the user for confirmation before installing in
#'   interactive sessions. Defaults to `interactive()`, so non-interactive
#'   sessions must pass `ask = FALSE` explicitly to proceed.
#'
#' @return Invisibly returns `TRUE` if all installations succeeded, `FALSE`
#'   otherwise (e.g., user declined, `remotes` not available, non-interactive).
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
install_dbvisuals_deps <- function(ask = interactive()) {
  cran_pkgs <- c("DBI", "duckdb")
  github_pkgs <- c("TiRizvanov/rDeckgl", "TiRizvanov/rMosaic")

  missing_cran <- cran_pkgs[
    !vapply(cran_pkgs, requireNamespace, logical(1L), quietly = TRUE)
  ]

  message(
    "install_dbvisuals_deps() will install the following packages:\n",
    "  CRAN:   ",
    if (length(missing_cran)) {
      paste(missing_cran, collapse = ", ")
    } else {
      "(all installed)"
    },
    "\n  GitHub: ",
    paste(github_pkgs, collapse = ", "),
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
    message("Installing CRAN packages: ", paste(missing_cran, collapse = ", "))
    utils::install.packages(missing_cran)
  } else {
    message("All CRAN packages already installed.")
  }

  if (!requireNamespace("remotes", quietly = TRUE)) {
    message(
      "Package 'remotes' is required to install rDeckgl / rMosaic from GitHub. ",
      "Install it with install.packages('remotes') and re-run this function."
    )
    return(invisible(FALSE))
  }

  message("Installing visualization packages from GitHub...")
  remotes::install_github(github_pkgs)

  message("\n\u2713 dbVisuals dependencies installation complete!")
  invisible(TRUE)
}
