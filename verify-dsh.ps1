<#
.SYNOPSIS
  Verify an installed il-radar skill against its source package.

.DESCRIPTION
  Recomputes SHA-256 for the installed files and compares them against the source package, so
  a partial copy, a stray edit or disk corruption is caught before a session depends on it.
  The skill name is read from the package's SKILL.md frontmatter.
  Exits 0 when everything matches, 1 otherwise.

.EXAMPLE
  .\verify-dsh.ps1
.EXAMPLE
  .\verify-dsh.ps1 -SkillsRoot "$HOME\.dsh\skills"
#>
[CmdletBinding()]
param(
    [string] $PackageRoot,
    [string] $SkillsRoot,
    [string] $ProjectRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $PackageRoot) { $PackageRoot = $PSScriptRoot }
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot)

# Read the skill name from the package so a renamed skill still verifies.
$SkillName = $null
if (Test-Path -LiteralPath (Join-Path $PackageRoot 'SKILL.md')) {
    $frontmatter = (Get-Content -LiteralPath (Join-Path $PackageRoot 'SKILL.md') -Encoding UTF8 -TotalCount 5) -join "`n"
    if ($frontmatter -match '(?m)^name:\s*(\S+)\s*$') { $SkillName = $Matches[1] }
}
if (-not $SkillName) { throw "Cannot read the skill name from $PackageRoot\SKILL.md frontmatter." }

# Mirror the installer's root resolution so both agree on the installed location.
function Find-ProjectRoot {
    param([string] $Start)
    $cursor = [IO.Path]::GetFullPath($Start)
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $cursor '.git')) { return $cursor }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { return [IO.Path]::GetFullPath($Start) }
        $cursor = $parent
    }
}

if (-not $ProjectRoot) { $ProjectRoot = Find-ProjectRoot -Start (Get-Location).Path }
if (-not $SkillsRoot) { $SkillsRoot = Join-Path ([IO.Path]::GetFullPath($ProjectRoot)) '.dsh\skills' }
$target = Join-Path ([IO.Path]::GetFullPath($SkillsRoot)) $SkillName

$bundleSource = $PackageRoot
$adapterSource = $PackageRoot
$adapterFiles = @('daemon.cjs', 'ailit.cjs', 'ailit.ps1')
$payloadDirectories = @('scripts', 'references', 'runtime', 'tools')
if (-not (Test-Path -LiteralPath (Join-Path $bundleSource 'scripts\browser.cjs'))) { throw "Source package is incomplete: $bundleSource" }
if (-not (Test-Path -LiteralPath (Join-Path $bundleSource 'references\question-bank.json'))) { throw "Question bank is missing: $bundleSource\references\question-bank.json" }
if (-not (Test-Path -LiteralPath $target)) { throw "Skill is not installed at $target; run setup-dsh.ps1 first." }

function Get-FileHashSafe {
    param([string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

$problems = [System.Collections.Generic.List[string]]::new()
$checked = 0

# 1. Adapter files and the DSH skill definition must match the package exactly.
foreach ($pair in @(
    @{ Source = (Join-Path $adapterSource 'daemon.cjs'); Target = (Join-Path $target 'daemon.cjs') },
    @{ Source = (Join-Path $adapterSource 'ailit.cjs'); Target = (Join-Path $target 'ailit.cjs') },
    @{ Source = (Join-Path $adapterSource 'ailit.ps1'); Target = (Join-Path $target 'ailit.ps1') },
    @{ Source = (Join-Path $adapterSource 'SKILL.md'); Target = (Join-Path $target 'SKILL.md') }
)) {
    $checked += 1
    if (-not (Test-Path -LiteralPath $pair.Target -PathType Leaf)) { $problems.Add("missing installed file: $($pair.Target)"); continue }
    if ((Get-FileHashSafe $pair.Source) -ne (Get-FileHashSafe $pair.Target)) { $problems.Add("content differs from the package: $($pair.Target)") }
}

# 2. Every payload file present in the package must be installed and identical. The installer
#    skips the legacy repl snippets, so they are skipped here too.
$payloadCount = 0
foreach ($directory in $payloadDirectories) {
    $sourceDirectory = Join-Path $bundleSource $directory
    if (-not (Test-Path -LiteralPath $sourceDirectory)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $sourceDirectory -Recurse -File -Force) {
        $relative = $file.FullName.Substring($bundleSource.Length).TrimStart('\')
        if ($relative -match '^references\\runtime\\repl\\') { continue }
        $installed = Join-Path $target $relative
        $checked += 1
        $payloadCount += 1
        if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { $problems.Add("missing installed file: $relative"); continue }
        if ((Get-FileHashSafe $file.FullName) -ne (Get-FileHashSafe $installed)) { $problems.Add("content differs from the package: $relative") }
    }
}

# 3. The recorded Playwright runtime must exist and expose the pinned library.
$runtimeRecord = Join-Path $target 'runtime-path.txt'
if (-not (Test-Path -LiteralPath $runtimeRecord -PathType Leaf)) {
    $problems.Add('missing runtime-path.txt; run setup-dsh.ps1')
} else {
    $runtime = (Get-Content -LiteralPath $runtimeRecord -Raw -Encoding UTF8).Trim()
    if (-not (Test-Path -LiteralPath (Join-Path $runtime 'node_modules\playwright'))) {
        $problems.Add("Playwright runtime is missing at the recorded path: $runtime")
    } else {
        $expected = (Get-Content -LiteralPath (Join-Path $bundleSource 'runtime\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).dependencies.playwright
        $manifest = Get-Content -LiteralPath (Join-Path $runtime 'node_modules\playwright\package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($manifest.version -ne $expected) { $problems.Add("Playwright version $($manifest.version) differs from pinned $expected") }
    }
}

if ($problems.Count) {
    Write-Output "FAIL: $($problems.Count) problem(s) across $checked checked files."
    $problems | Select-Object -First 20 | ForEach-Object { Write-Output "  - $_" }
    exit 1
}
Write-Output "OK: $checked files match the package ($payloadCount payload + 4 adapter/definition), and the Playwright runtime is present."
exit 0
