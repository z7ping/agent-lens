$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $root 'apps/desktop/assets/icon.png'
$outputPath = Join-Path $root 'apps/desktop/assets/icon-win.png'
$size = 512

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "没有找到正式 Logo：$sourcePath"
}

$source = $null
$bitmap = $null
$graphics = $null
try {
  $source = [System.Drawing.Image]::FromFile($sourcePath)
  if ($source.Width -ne $source.Height -or $source.Width -lt 256) {
    throw "Windows 应用图标至少需要 256x256 的正方形源图，当前为 $($source.Width)x$($source.Height)"
  }

  # 24 位 RGB 不包含 Alpha 通道。先用桌面壳的深色基底铺满，再按正式 Logo
  # 的透明度合成，因此资源写入 EXE / 快捷方式后不会出现整张图被当作透明的情况。
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
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

$check = [System.Drawing.Bitmap]::FromFile($outputPath)
try {
  if ($check.Width -ne $size -or $check.Height -ne $size) {
    throw "Windows 图标生成尺寸异常：$($check.Width)x$($check.Height)"
  }
  if ($check.PixelFormat -band [System.Drawing.Imaging.PixelFormat]::Alpha) {
    throw "Windows 图标仍包含 Alpha 通道：$($check.PixelFormat)"
  }
  if ($check.PixelFormat -band [System.Drawing.Imaging.PixelFormat]::PAlpha) {
    throw "Windows 图标仍包含预乘 Alpha 通道：$($check.PixelFormat)"
  }
  Write-Host "[AgentLens] Windows 图标已生成：$outputPath（$size x $size，$($check.PixelFormat)，无透明通道）"
}
finally {
  $check.Dispose()
}
