$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$assetRoot = Join-Path $root 'apps/desktop/assets'
$windowPng = Join-Path $assetRoot 'icon-window.png'
$compatPng = Join-Path $assetRoot 'icon-win.png'
$appIco = Join-Path $assetRoot 'icon-app.ico'
$trayIco = Join-Path $assetRoot 'tray.ico'

function New-RoundedRectPath([single]$x, [single]$y, [single]$width, [single]$height, [single]$radius) {
  $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-GradientBrush(
  [System.Drawing.RectangleF]$rect,
  [string[]]$colors,
  [single[]]$positions,
  [single]$angle = 45
) {
  if ($colors.Count -ne $positions.Count -or $colors.Count -lt 2) {
    throw 'Gradient colors/positions mismatch'
  }

  $brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    $rect,
    [System.Drawing.Color]::Black,
    [System.Drawing.Color]::White,
    $angle
  )
  $blend = [System.Drawing.Drawing2D.ColorBlend]::new($colors.Count)
  $blend.Colors = [System.Drawing.Color[]]@($colors | ForEach-Object {
    [System.Drawing.ColorTranslator]::FromHtml($_)
  })
  $blend.Positions = [single[]]$positions
  $brush.InterpolationColors = $blend
  return $brush
}

function Draw-AppIcon([System.Drawing.Graphics]$graphics) {
  # 1254 x 1254 坐标与 docs/design/brand/agentlens-icon-master.svg 保持一致。
  $bgBrush = New-GradientBrush ([System.Drawing.RectangleF]::new(0, 0, 1254, 1254)) @('#005DFF', '#007FFA', '#00A1F2', '#00C0EC', '#00DDE4') @([single]0, [single]0.27, [single]0.55, [single]0.78, [single]1) 45
  $bgPath = New-RoundedRectPath 0 0 1254 1254 250
  try {
    $graphics.FillPath($bgBrush, $bgPath)
  } finally {
    $bgBrush.Dispose()
    $bgPath.Dispose()
  }

  $whiteBody = New-GradientBrush ([System.Drawing.RectangleF]::new(628, 395, 477, 474)) @('#FFFFFF', '#FFFDFD', '#F8F7F9') @([single]0, [single]0.58, [single]1) 41

  $rear = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $rear.StartFigure()
    $rear.AddLine(934, 454, 1012, 454)
    $rear.AddBezier(1012, 454, 1068, 454, 1105, 532, 1105, 632)
    $rear.AddBezier(1105, 632, 1105, 732, 1068, 810, 1012, 810)
    $rear.AddLine(1012, 810, 934, 810)
    $rear.AddBezier(934, 810, 970, 766, 989, 703, 989, 632)
    $rear.AddBezier(989, 632, 989, 561, 970, 498, 934, 454)
    $rear.CloseFigure()
    $graphics.FillPath($whiteBody, $rear)
  } finally {
    $rear.Dispose()
  }

  $ring = [System.Drawing.Drawing2D.GraphicsPath]::new([System.Drawing.Drawing2D.FillMode]::Alternate)
  try {
    $ring.StartFigure()
    $ring.AddLine(767, 395, 844, 395)
    $ring.AddBezier(844, 395, 920, 395, 973, 495, 973, 632)
    $ring.AddBezier(973, 632, 973, 769, 920, 869, 844, 869)
    $ring.AddLine(844, 869, 767, 869)
    $ring.AddBezier(767, 869, 688, 869, 628, 769, 628, 632)
    $ring.AddBezier(628, 632, 628, 495, 688, 395, 767, 395)
    $ring.CloseFigure()

    $ring.StartFigure()
    $ring.AddBezier(768, 431, 711, 431, 667, 520, 667, 632)
    $ring.AddBezier(667, 632, 667, 744, 711, 832, 768, 832)
    $ring.AddBezier(768, 832, 825, 832, 869, 744, 869, 632)
    $ring.AddBezier(869, 632, 869, 520, 825, 431, 768, 431)
    $ring.CloseFigure()
    $graphics.FillPath($whiteBody, $ring)
  } finally {
    $ring.Dispose()
    $whiteBody.Dispose()
  }

  $upperBrush = New-GradientBrush ([System.Drawing.RectangleF]::new(268, 391, 478, 239)) @('#D8FFFF', '#FFFFFF', '#FFFFFF', '#FFF4DE') @([single]0, [single]0.2, [single]0.84, [single]1) 26
  $upper = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $upper.StartFigure()
    $upper.AddBezier(270, 391, 356, 411, 439, 465, 514, 522)
    $upper.AddBezier(514, 522, 580, 572, 632, 600, 704, 618)
    $upper.AddLine(704, 618, 746, 630)
    $upper.AddLine(746, 630, 704, 627)
    $upper.AddBezier(704, 627, 628, 615, 572, 592, 518, 559)
    $upper.AddBezier(518, 559, 429, 505, 364, 446, 268, 420)
    $upper.AddLine(268, 420, 270, 391)
    $upper.CloseFigure()
    $graphics.FillPath($upperBrush, $upper)
  } finally {
    $upper.Dispose()
    $upperBrush.Dispose()
  }

  $lowerBrush = New-GradientBrush ([System.Drawing.RectangleF]::new(268, 630, 478, 238)) @('#C6DBFF', '#F9FDFF', '#FFFFFF', '#FFF4DE') @([single]0, [single]0.22, [single]0.84, [single]1) 334
  $lower = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $lower.StartFigure()
    $lower.AddBezier(268, 839, 366, 810, 428, 754, 514, 695)
    $lower.AddBezier(514, 695, 583, 648, 640, 632, 704, 633)
    $lower.AddLine(704, 633, 746, 630)
    $lower.AddLine(746, 630, 704, 639)
    $lower.AddBezier(704, 639, 636, 656, 586, 679, 538, 710)
    $lower.AddBezier(538, 710, 450, 767, 381, 831, 271, 868)
    $lower.AddLine(271, 868, 268, 839)
    $lower.CloseFigure()
    $graphics.FillPath($lowerBrush, $lower)
  } finally {
    $lower.Dispose()
    $lowerBrush.Dispose()
  }

  $upperNode = New-GradientBrush ([System.Drawing.RectangleF]::new(189, 355, 92, 92)) @('#80FBD5', '#70FBE0') @([single]0, [single]1) 50
  $lowerNode = New-GradientBrush ([System.Drawing.RectangleF]::new(189, 816, 92, 92)) @('#74A6FC', '#6B9DFF') @([single]0, [single]1) 45
  $centerNode = New-GradientBrush ([System.Drawing.RectangleF]::new(698, 569, 92, 122)) @('#FFB10F', '#FDA122', '#FF7B20') @([single]0, [single]0.35, [single]1) 53
  try {
    $graphics.FillEllipse($upperNode, 189, 355, 92, 92)
    $graphics.FillEllipse($lowerNode, 189, 816, 92, 92)
    $graphics.FillEllipse($centerNode, 698, 569, 92, 122)
  } finally {
    $upperNode.Dispose()
    $lowerNode.Dispose()
    $centerNode.Dispose()
  }

}

function Draw-SmallIcon([System.Drawing.Graphics]$graphics) {
  # 小尺寸不再维护另一套旧几何；直接从新主母版坐标统一派生。
  $state = $graphics.Save()
  try {
    $graphics.ScaleTransform([single](64.0 / 1254.0), [single](64.0 / 1254.0))
    Draw-AppIcon $graphics
  } finally {
    $graphics.Restore($state)
  }
}

function New-IconBitmap([int]$size, [bool]$small) {
  $bitmap = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    if ($small) {
      $graphics.ScaleTransform([single]($size / 64.0), [single]($size / 64.0))
      Draw-SmallIcon $graphics
    } else {
      $graphics.ScaleTransform([single]($size / 1254.0), [single]($size / 1254.0))
      Draw-AppIcon $graphics
    }
  } finally {
    $graphics.Dispose()
  }
  return $bitmap
}

function Get-PngBytes([int]$size, [bool]$small) {
  $bitmap = New-IconBitmap $size $small
  $stream = [System.IO.MemoryStream]::new()
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return ,$stream.ToArray()
  } finally {
    $stream.Dispose()
    $bitmap.Dispose()
  }
}

function Save-Png([string]$path, [int]$size, [bool]$small) {
  $bytes = [byte[]](Get-PngBytes $size $small)
  [System.IO.File]::WriteAllBytes($path, $bytes)
}

function Assert-TransparentCorners([string]$path) {
  $bitmap = [System.Drawing.Bitmap]::FromFile($path)
  try {
    $corners = @(
      $bitmap.GetPixel(0, 0),
      $bitmap.GetPixel($bitmap.Width - 1, 0),
      $bitmap.GetPixel(0, $bitmap.Height - 1),
      $bitmap.GetPixel($bitmap.Width - 1, $bitmap.Height - 1)
    )
    foreach ($pixel in $corners) {
      if ($pixel.A -ne 0) {
        throw "Windows icon corner is not transparent: $path (alpha=$($pixel.A))"
      }
    }
  } finally {
    $bitmap.Dispose()
  }
}

function Write-Ico([string]$path, [int[]]$sizes) {
  $images = @()
  foreach ($size in $sizes) {
    $images += ,([byte[]](Get-PngBytes $size ($size -le 48)))
  }

  $stream = [System.IO.MemoryStream]::new()
  $writer = [System.IO.BinaryWriter]::new($stream)
  try {
    $writer.Write([uint16]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]$sizes.Count)
    $offset = 6 + (16 * $sizes.Count)
    for ($i = 0; $i -lt $sizes.Count; $i++) {
      $size = $sizes[$i]
      $bytes = [byte[]]$images[$i]
      $writer.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
      $writer.Write([byte]($(if ($size -ge 256) { 0 } else { $size })))
      $writer.Write([byte]0)
      $writer.Write([byte]0)
      $writer.Write([uint16]1)
      $writer.Write([uint16]32)
      $writer.Write([uint32]$bytes.Length)
      $writer.Write([uint32]$offset)
      $offset += $bytes.Length
    }
    foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
    $writer.Flush()
    [System.IO.File]::WriteAllBytes($path, $stream.ToArray())
  } finally {
    $writer.Dispose()
    $stream.Dispose()
  }
}

New-Item -ItemType Directory -Force -Path $assetRoot | Out-Null
Save-Png $windowPng 256 $false
Save-Png $compatPng 512 $false
Write-Ico $appIco @(16, 20, 24, 32, 40, 48, 64, 128, 256)
Write-Ico $trayIco @(16, 20, 24, 32, 40, 48)
Assert-TransparentCorners $windowPng
Assert-TransparentCorners $compatPng

$windowCheck = [System.Drawing.Image]::FromFile($windowPng)
try {
  if ($windowCheck.Width -ne 256 -or $windowCheck.Height -ne 256) { throw 'Unexpected window icon dimensions' }
} finally {
  $windowCheck.Dispose()
}

$appBytes = [System.IO.File]::ReadAllBytes($appIco)
$trayBytes = [System.IO.File]::ReadAllBytes($trayIco)
$appCount = [System.BitConverter]::ToUInt16($appBytes, 4)
$trayCount = [System.BitConverter]::ToUInt16($trayBytes, 4)
if ($appCount -ne 9) { throw "Unexpected app ICO frame count: $appCount" }
if ($trayCount -ne 6) { throw "Unexpected tray ICO frame count: $trayCount" }

Write-Host "[AgentLens] Windows brand assets ready from 1254 master geometry: app ICO=$appCount frames; tray ICO=$trayCount frames; window PNG=256px; compatibility PNG=512px"
