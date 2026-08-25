$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root 'apps/desktop/assets/icon.png'
$outputPath = Join-Path $root 'apps/desktop/assets/icon-win.png'
$size = 512

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "AgentLens icon source was not found: $sourcePath"
}

$source = $null
$bitmap = $null
$graphics = $null
try {
  $source = [System.Drawing.Image]::FromFile($sourcePath)
  if ($source.Width -ne $source.Height -or $source.Width -lt 256) {
    throw "Windows app icon must be a square image at least 256x256; got $($source.Width)x$($source.Height)"
  }

  # Format24bppRgb has no alpha channel. Fill the desktop shell background first,
  # then composite the formal logo so Windows shell resources cannot become blank.
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.Clear([System.Drawing.Color]::FromArgb(11, 13, 16))
  $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.DrawImage($source, 0, 0, $size, $size)

  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
  if ($null -ne $graphics) { $graphics.Dispose() }
  if ($null -ne $bitmap) { $bitmap.Dispose() }
  if ($null -ne $source) { $source.Dispose() }
}

$check = [System.Drawing.Image]::FromFile($outputPath)
try {
  if ($check.Width -ne $size -or $check.Height -ne $size) {
    throw "Generated Windows icon has unexpected dimensions: $($check.Width)x$($check.Height)"
  }
  if ($check.PixelFormat -band [System.Drawing.Imaging.PixelFormat]::Alpha) {
    throw "Generated Windows icon still has an alpha channel: $($check.PixelFormat)"
  }
  if ($check.PixelFormat -band [System.Drawing.Imaging.PixelFormat]::PAlpha) {
    throw "Generated Windows icon still has premultiplied alpha: $($check.PixelFormat)"
  }
  Write-Host "[AgentLens] Windows icon ready: $outputPath ($size x $size, $($check.PixelFormat), opaque)"
}
finally {
  $check.Dispose()
}
