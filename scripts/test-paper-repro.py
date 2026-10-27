#!/usr/bin/env python3
"""Repository-only reproduction contracts (no private/ignored files).

Run with: python3 scripts/test-paper-repro.py
The examples are deliberately excluded from the CRAN source package.
"""
import pathlib
import re
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class PaperReproduction(unittest.TestCase):
    def test_documented_source_routes_are_publishable(self):
        vignette = (ROOT / "r-package/vignettes/reproducing-paper-figures.Rmd").read_text()
        routes = re.findall(r'source\("(examples/[^\"]+\.R)"\)', vignette)
        self.assertGreaterEqual(len(routes), 2)
        publishable = set(subprocess.check_output(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
            cwd=ROOT, text=True).splitlines())
        for route in routes:
            with self.subTest(route=route):
                relative = "r-package/" + route
                self.assertIn(relative, publishable,
                              "A documented source() target must survive a fresh clone")
                text = (ROOT / relative).read_text()
                self.assertNotRegex(text, r"/(?:Users|home)/[^/]+/")

    def test_vignette_points_to_published_branch_and_routes(self):
        text = (ROOT / 'r-package/vignettes/reproducing-paper-figures.Rmd').read_text()
        self.assertIn('git clone --branch v0.1.0 https://github.com/dbverse-org/dbVisuals.git', text)
        self.assertNotIn('dbVisuals2', text)
        self.assertNotIn('they are gitignored', text)
        self.assertNotIn('01_in_situ_with_marginals.R', text)

    def test_package_check_runs_the_test_suite(self):
        runner = ROOT / 'r-package/tests/testthat.R'
        self.assertTrue(runner.is_file(), 'R CMD check must discover a test entry point')
        self.assertIn('test_check("dbVisuals")', runner.read_text())

    def test_missing_annotations_are_not_simulated(self):
        text = (ROOT / 'r-package/examples/06_in_situ_zoom_overlay_transcripts_interactive.R').read_text()
        self.assertNotIn('rnorm(nrow(centroids)', text)

if __name__ == "__main__":
    unittest.main()
