param(
    [string]$HtmlPath = '',
    [string]$PdfPath = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$reportRoot = [System.IO.Path]::GetFullPath((Join-Path $repoRoot 'reports'))
if (-not $HtmlPath) { $HtmlPath = Join-Path $reportRoot 'MASTER-WORK-REPORT-2026-07-25.html' }
if (-not $PdfPath) { $PdfPath = Join-Path $reportRoot 'MASTER-WORK-REPORT-2026-07-25.pdf' }

$html = [System.IO.Path]::GetFullPath($HtmlPath)
$pdf = [System.IO.Path]::GetFullPath($PdfPath)
$reportPrefix = $reportRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
foreach ($candidate in @($html, $pdf)) {
    if (-not $candidate.StartsWith($reportPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Report input and output must remain inside the repository reports directory.'
    }
}
if (-not (Test-Path -LiteralPath $html -PathType Leaf)) { throw "Report HTML does not exist: $html" }
if ([System.IO.Path]::GetExtension($html) -ne '.html' -or [System.IO.Path]::GetExtension($pdf) -ne '.pdf') {
    throw 'Report input must be .html and output must be .pdf.'
}

$browserCandidates = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
if (-not $browserCandidates) {
    foreach ($name in @('chrome.exe', 'msedge.exe')) {
        $command = Get-Command $name -ErrorAction SilentlyContinue
        if ($command) { $browserCandidates += $command.Source }
    }
}
if (-not $browserCandidates) { throw 'Chrome or Edge is required to render the master report PDF.' }

$nextPdf = [System.IO.Path]::ChangeExtension($pdf, '.next.pdf')
$profile = Join-Path ([System.IO.Path]::GetTempPath()) ('toolsenabled-report-render-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profile | Out-Null

try {
    $uri = 'file:///' + ($html -replace '\\', '/')
    $arguments = @('--headless=new', '--disable-gpu', '--disable-gpu-compositing', '--in-process-gpu', '--disable-gpu-sandbox', '--disable-features=UseSkiaRenderer', '--disable-background-networking', '--disable-extensions', '--no-first-run', '--no-pdf-header-footer', "--user-data-dir=$profile", "--print-to-pdf=$nextPdf", $uri)
    $renderedBy = $null
    foreach ($browser in $browserCandidates) {
        $process = $null
        try {
            $process = Start-Process -FilePath $browser -ArgumentList $arguments -WorkingDirectory $repoRoot -WindowStyle Hidden -PassThru
            $deadline = [DateTime]::UtcNow.AddSeconds(20)
            while (-not (Test-Path -LiteralPath $nextPdf -PathType Leaf) -and -not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
                Start-Sleep -Milliseconds 200
            }
            if (Test-Path -LiteralPath $nextPdf -PathType Leaf) {
                $renderedBy = $browser
                break
            }
        } finally {
            if ($process -and -not $process.HasExited) {
                # Only stop the exact browser process we just launched. Its
                # path and dedicated temporary profile are fixed above; the
                # owner's normal browser is never targeted.
                try {
                    $current = Get-Process -Id $process.Id -ErrorAction Stop
                    if ($current.Path -and [System.IO.Path]::GetFullPath($current.Path) -ieq [System.IO.Path]::GetFullPath($browser)) {
                        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                    }
                } catch { }
            }
        }
        if (Test-Path -LiteralPath $nextPdf -PathType Leaf) { break }
    }
    if (-not (Test-Path -LiteralPath $nextPdf -PathType Leaf)) {
        $fallback = Join-Path $PSScriptRoot 'render-master-report-fallback.py'
        $python = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $python -or -not (Test-Path -LiteralPath $fallback -PathType Leaf)) {
            throw 'Chrome/Edge did not create the report PDF and the local PDF fallback is unavailable.'
        }
        & $python.Source $fallback $html $pdf
        if (-not (Test-Path -LiteralPath $pdf -PathType Leaf)) { throw 'The local PDF fallback did not create the report PDF.' }
        $fallbackBytes = [System.IO.File]::ReadAllBytes($pdf)
        if ($fallbackBytes.Length -lt 1024 -or [System.Text.Encoding]::ASCII.GetString($fallbackBytes, 0, 5) -ne '%PDF-') { throw 'The local PDF fallback created an invalid report PDF.' }
        [pscustomobject]@{ path = $pdf; bytes = $fallbackBytes.Length; header = '%PDF-'; rendered = $true; browser = 'PyMuPDF fallback' } | ConvertTo-Json -Compress
        return
    }

    $bytes = [System.IO.File]::ReadAllBytes($nextPdf)
    if ($bytes.Length -lt 1024 -or [System.Text.Encoding]::ASCII.GetString($bytes, 0, 5) -ne '%PDF-') {
        throw 'Chrome created an invalid report PDF.'
    }

    Move-Item -LiteralPath $nextPdf -Destination $pdf -Force
    [pscustomobject]@{
        path = $pdf
        bytes = $bytes.Length
        header = '%PDF-'
        rendered = $true
        browser = $renderedBy
    } | ConvertTo-Json -Compress
} finally {
    if (Test-Path -LiteralPath $nextPdf) {
        Remove-Item -LiteralPath $nextPdf -Force -ErrorAction SilentlyContinue
    }
    $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
    $resolvedProfile = [System.IO.Path]::GetFullPath($profile)
    $safeName = [System.IO.Path]::GetFileName($resolvedProfile) -match '^toolsenabled-report-render-[0-9a-f]{32}$'
    if ($safeName -and $resolvedProfile.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedProfile)) {
        Remove-Item -LiteralPath $resolvedProfile -Recurse -Force -ErrorAction SilentlyContinue
    }
}
