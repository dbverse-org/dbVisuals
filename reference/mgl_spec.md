# Construct a top-level Mosaic spec for the viewer

Accepts the same shape as Mosaic / rMosaic: meta, data, params, vconcat
/ hconcat / plot / input ...

## Usage

``` r
mgl_spec(...)
```

## Arguments

- ...:

  Named top-level fields of a Mosaic spec.

## Value

A list with class \`"mgl_spec"\`.

## Details

Pass each top-level field as a named argument and they will be packaged
into a list. To author specs ergonomically just build a regular R list.

## See also

\[mosaic_gl()\] for a complete linked example.

## Examples

``` r
spec <- mgl_spec(
  data = list(pts = mgl_data(type = "table",
                             df = data.frame(x = 1:3, y = c(2, 4, 3)))),
  plot = list(list(mark = "dot", data = list(from = "pts"), x = "x", y = "y"))
)
names(spec)
#> [1] "data" "plot"
```
