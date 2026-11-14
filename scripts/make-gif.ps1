# Builds a looping animated GIF from PNG frames using only what ships with Windows (WPF).
# WPF's GIF encoder writes frames without timing, so the delays and the loop flag are patched in afterwards.
#   ./scripts/make-gif.ps1 -Frames docs/demo/frames -Out docs/demo/scenario-1-replay.gif -DelaysMs 2500,2000,...
param(
  [Parameter(Mandatory)][string]$Frames,
  [Parameter(Mandatory)][string]$Out,
  [int[]]$DelaysMs = @(1800)
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, WindowsBase

$files = Get-ChildItem $Frames -Filter *.png | Sort-Object { [int]($_.BaseName -replace '\D', '') }
$enc = New-Object System.Windows.Media.Imaging.GifBitmapEncoder
foreach ($f in $files) {
  $s = [IO.File]::OpenRead($f.FullName)
  $frame = [System.Windows.Media.Imaging.BitmapFrame]::Create($s, 'None', 'OnLoad')
  $s.Close()
  $enc.Frames.Add($frame)
}
$ms = New-Object IO.MemoryStream
$enc.Save($ms)
$src = $ms.ToArray()

$dst = New-Object IO.MemoryStream
function Copy-Bytes([int]$from, [int]$count) { $dst.Write($src, $from, $count) }
function Skip-SubBlocks([int]$p) { while ($src[$p] -ne 0) { $p += $src[$p] + 1 }; return $p + 1 }

# Header + logical screen descriptor (+ global colour table)
$p = 13
if ($src[10] -band 0x80) { $p += 3 * [Math]::Pow(2, ($src[10] -band 7) + 1) }
Copy-Bytes 0 $p
# Loop forever
$dst.Write([byte[]](0x21, 0xFF, 0x0B, 0x4E, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2E, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00), 0, 19)

$i = 0
while ($p -lt $src.Length) {
  $b = $src[$p]
  if ($b -eq 0x3B) { $dst.WriteByte(0x3B); break }
  if ($b -eq 0x21) {
    $end = Skip-SubBlocks ($p + 2)
    # Drop the encoder's own graphic control and application extensions; ours replace them.
    if ($src[$p + 1] -ne 0xF9 -and $src[$p + 1] -ne 0xFF) { Copy-Bytes $p ($end - $p) }
    $p = $end
    continue
  }
  if ($b -eq 0x2C) {
    $delay = [int]($DelaysMs[[Math]::Min($i, $DelaysMs.Length - 1)] / 10)
    $dst.Write([byte[]](0x21, 0xF9, 0x04, 0x04, ($delay -band 0xFF), (($delay -shr 8) -band 0xFF), 0x00, 0x00), 0, 8)
    $q = $p + 10
    if ($src[$p + 9] -band 0x80) { $q += 3 * [Math]::Pow(2, ($src[$p + 9] -band 7) + 1) }
    $q = Skip-SubBlocks ($q + 1)
    Copy-Bytes $p ($q - $p)
    $p = $q
    $i++
    continue
  }
  throw "Unexpected GIF block 0x$('{0:X2}' -f $b) at $p"
}
[IO.File]::WriteAllBytes((Join-Path (Get-Location) $Out), $dst.ToArray())
Write-Host "wrote $Out ($i frames, $([int]($dst.Length / 1024)) KB)"
