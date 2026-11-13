param()

$ErrorActionPreference = 'Stop'
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$projectPrefix = $projectRoot.TrimEnd('\') + '\'
$outputDirectory = Join-Path $projectRoot 'dist'
$outputFile = [System.IO.Path]::GetFullPath((Join-Path $outputDirectory 'xiaoyan-qqbot-altare.zip'))
if (-not $outputFile.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output must stay inside the project.'
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$files = @()
foreach ($relative in @('package.json', 'package-lock.json', 'altare.js', '.npmrc', '.env.example', '.gitignore', 'README.md', 'ALTARE.md', 'src/eval-rubric.json')) {
    $fullPath = Join-Path $projectRoot $relative
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Missing required project file: $relative"
    }
    $files += Get-Item -LiteralPath $fullPath -Force
}
foreach ($directory in @('src', 'scripts', 'docs')) {
    # 内部复盘/修复记录不进部署包，只带使用文档与准则
    $files += Get-ChildItem -LiteralPath (Join-Path $projectRoot $directory) -File -Force -Recurse |
        Where-Object { $_.Extension -in @('.js', '.mjs', '.ps1', '.md') -and $_.Name -notmatch '-2026-\d{2}-\d{2}\.md$' }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [System.IO.File]::Open($outputFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::ReadWrite)
$archive = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in ($files | Sort-Object -Property FullName -Unique)) {
        $fullPath = [System.IO.Path]::GetFullPath($file.FullName)
        if (-not $fullPath.StartsWith($projectPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Source path is outside the project.'
        }
        $relative = $fullPath.Substring($projectPrefix.Length).Replace('\', '/')
        if ($relative -eq '.env' -or $relative -match '^(data|node_modules|dist|seed)/') {
            throw "Private or generated file refused: $relative"
        }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $fullPath, $relative) | Out-Null
    }
} finally {
    $archive.Dispose()
    $stream.Dispose()
}
Write-Output "Created: $outputFile"
Write-Output 'Excluded: real .env, runtime data, node_modules, old archives and seed databases.'


