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

function New-LinearBrush([System.Drawing.RectangleF]$rect, [System.Drawing.Color]$start, [System.Drawing.Color]$end, [single]$angle = 45) {
  return [System.Drawing.Drawing2D.LinearGradientBrush]::new($rect, $start, $end, $angle)
}

function Draw-AppIcon([System.Drawing.Graphics]$graphics) {
  $bgRect = [System.Drawing.RectangleF]::new(0, 0, 1024, 1024)
  $bgBrush = New-LinearBrush $bgRect ([System.Drawing.ColorTranslator]::FromHtml('#1768f2')) ([System.Drawing.ColorTranslator]::FromHtml('#20d8cf')) 45
  $bgPath = New-RoundedRectPath 0 0 1024 1024 196
  try { $graphics.FillPath($bgBrush, $bgPath) } finally { $bgBrush.Dispose(); $bgPath.Dispose() }

  $white = [System.Drawing.Brushes]::White

  $rearPath = New-RoundedRectPath 716 360 150 310 76
  try { $graphics.FillPath($white, $rearPath) } finally { $rearPath.Dispose() }
  $rearHoleBrush = New-LinearBrush $bgRect ([System.Drawing.ColorTranslator]::FromHtml('#1768f2')) ([System.Drawing.ColorTranslator]::FromHtml('#20d8cf')) 45
  try { $graphics.FillEllipse($rearHoleBrush, 715, 394, 86, 242) } finally { $rearHoleBrush.Dispose() }

  $frontPath = New-RoundedRectPath 518 314 222 402 112
  try { $graphics.FillPath($white, $frontPath) } finally { $frontPath.Dispose() }
  $frontHoleBrush = New-LinearBrush $bgRect ([System.Drawing.ColorTranslator]::FromHtml('#1768f2')) ([System.Drawing.ColorTranslator]::FromHtml('#20d8cf')) 45
  try { $graphics.FillEllipse($frontHoleBrush, 559, 365, 116, 300) } finally { $frontHoleBrush.Dispose() }

  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 18)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $upper = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $lower = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $upper.AddBezier(192, 318, 308, 344, 420, 438, 600, 514)
    $lower.AddBezier(192, 700, 318, 674, 438, 574, 600, 516)
    $graphics.DrawPath($pen, $upper)
    $graphics.DrawPath($pen, $lower)
  } finally { $upper.Dispose(); $lower.Dispose(); $pen.Dispose() }

  $mintBrush = New-LinearBrush ([System.Drawing.RectangleF]::new(154, 280, 76, 76)) ([System.Drawing.ColorTranslator]::FromHtml('#35dfe0')) ([System.Drawing.ColorTranslator]::FromHtml('#7ff1bd')) 45
  $violetBrush = New-LinearBrush ([System.Drawing.RectangleF]::new(154, 662, 76, 76)) ([System.Drawing.ColorTranslator]::FromHtml('#85a9ff')) ([System.Drawing.ColorTranslator]::FromHtml('#5b68ef')) 45
  $focusBrush = New-LinearBrush ([System.Drawing.RectangleF]::new(552, 467, 96, 96)) ([System.Drawing.ColorTranslator]::FromHtml('#ffc22b')) ([System.Drawing.ColorTranslator]::FromHtml('#ff7a21')) 90
  try {
    $graphics.FillEllipse($mintBrush, 154, 280, 76, 76)
    $graphics.FillEllipse($violetBrush, 154, 662, 76, 76)
    $graphics.FillEllipse($focusBrush, 552, 467, 96, 96)
  } finally { $mintBrush.Dispose(); $violetBrush.Dispose(); $focusBrush.Dispose() }
}

function Draw-SmallIcon([System.Drawing.Graphics]$graphics) {
  $bgRect = [System.Drawing.RectangleF]::new(0, 0, 64, 64)
  $bgBrush = New-LinearBrush $bgRect ([System.Drawing.ColorTranslator]::FromHtml('#1768f2')) ([System.Drawing.ColorTranslator]::FromHtml('#20d8cf')) 45
  $bgPath = New-RoundedRectPath 0 0 64 64 12
  try { $graphics.FillPath($bgBrush, $bgPath) } finally { $bgBrush.Dispose(); $bgPath.Dispose() }

  $rearPath = New-RoundedRectPath 48 18 11 28 5.5
  try { $graphics.FillPath([System.Drawing.Brushes]::White, $rearPath) } finally { $rearPath.Dispose() }
  $rearHoleBrush = New-LinearBrush $bgRect ([System.Drawing.ColorTranslator]::FromHtml('#1768f2')) ([System.Drawing.ColorTranslator]::FromHtml('#20d8cf')) 45
  try { $graphics.FillEllipse($rearHoleBrush, 48.9, 23.4, 5.2, 17.2) } finally { $rearHoleBrush.Dispose() }

  $frontPath = New-RoundedRectPath 37 14 17 36 8.5
  try { $graphics.FillPath([System.Drawing.Brushes]::White, $frontPath) } finally { $frontPath.Dispose() }
  $frontHoleBrush = New-LinearBrush $bgRect ([System.Drawing.ColorTranslator]::FromHtml('#1768f2')) ([System.Drawing.ColorTranslator]::FromHtml('#20d8cf')) 45
  try { $graphics.FillEllipse($frontHoleBrush, 40.3, 20.8, 7.4, 22.4) } finally { $frontHoleBrush.Dispose() }

  $pen = [System.Drawing.Pen]::new([System.Drawing.Color]::White, 3.2)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $upper = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $lower = [System.Drawing.Drawing2D.GraphicsPath]::new()
  try {
    $upper.AddBezier(12, 18, 21, 20, 29, 27, 41, 32)
    $lower.AddBezier(12, 46, 22, 44, 30, 37, 41, 32)
    $graphics.DrawPath($pen, $upper)
    $graphics.DrawPath($pen, $lower)
  } finally { $upper.Dispose(); $lower.Dispose(); $pen.Dispose() }

  $mintBrush = New-LinearBrush ([System.Drawing.RectangleF]::new(7.5, 13.5, 9, 9)) ([System.Drawing.ColorTranslator]::FromHtml('#35dfe0')) ([System.Drawing.ColorTranslator]::FromHtml('#7ff1bd')) 45
  $violetBrush = New-LinearBrush ([System.Drawing.RectangleF]::new(7.5, 41.5, 9, 9)) ([System.Drawing.ColorTranslator]::FromHtml('#85a9ff')) ([System.Drawing.ColorTranslator]::FromHtml('#5b68ef')) 45
  $focusBrush = New-LinearBrush ([System.Drawing.RectangleF]::new(36.5, 27.5, 9, 9)) ([System.Drawing.ColorTranslator]::FromHtml('#ffc22b')) ([System.Drawing.ColorTranslator]::FromHtml('#ff7a21')) 90
  try {
    $graphics.FillEllipse($mintBrush, 7.5, 13.5, 9, 9)
    $graphics.FillEllipse($violetBrush, 7.5, 41.5, 9, 9)
    $graphics.FillEllipse($focusBrush, 36.5, 27.5, 9, 9)
  } finally { $mintBrush.Dispose(); $violetBrush.Dispose(); $focusBrush.Dispose() }
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
      $graphics.ScaleTransform($size / 64.0, $size / 64.0)
      Draw-SmallIcon $graphics
    } else {
      $graphics.ScaleTransform($size / 1024.0, $size / 1024.0)
      Draw-AppIcon $graphics
    }
  } finally { $graphics.Dispose() }
  return $bitmap
}

function Get-PngBytes([int]$size, [bool]$small) {
  $bitmap = New-IconBitmap $size $small
  $stream = [System.IO.MemoryStream]::new()
  try {
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    return ,$stream.ToArray()
  } finally { $stream.Dispose(); $bitmap.Dispose() }
}

function Save-Png([string]$path, [int]$size, [bool]$small) {
  $bytes = [byte[]](Get-PngBytes $size $small)
  [System.IO.File]::WriteAllBytes($path, $bytes)
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
  } finally { $writer.Dispose(); $stream.Dispose() }
}

New-Item -ItemType Directory -Force -Path $assetRoot | Out-Null
Save-Png $windowPng 256 $false
Save-Png $compatPng 512 $false
Write-Ico $appIco @(16, 20, 24, 32, 40, 48, 64, 128, 256)
Write-Ico $trayIco @(16, 20, 24, 32, 40, 48)

$windowCheck = [System.Drawing.Image]::FromFile($windowPng)
try {
  if ($windowCheck.Width -ne 256 -or $windowCheck.Height -ne 256) { throw 'Unexpected window icon dimensions' }
} finally { $windowCheck.Dispose() }

$appBytes = [System.IO.File]::ReadAllBytes($appIco)
$trayBytes = [System.IO.File]::ReadAllBytes($trayIco)
$appCount = [System.BitConverter]::ToUInt16($appBytes, 4)
$trayCount = [System.BitConverter]::ToUInt16($trayBytes, 4)
if ($appCount -ne 9) { throw "Unexpected app ICO frame count: $appCount" }
if ($trayCount -ne 6) { throw "Unexpected tray ICO frame count: $trayCount" }

Write-Host "[AgentLens] Windows brand assets ready: app ICO=$appCount frames; tray ICO=$trayCount frames; window PNG=256px; compatibility PNG=512px"
