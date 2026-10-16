<#
.SYNOPSIS
  DSH wrapper for the ai-literacy-search skill: talks to the persistent Chrome daemon.

.DESCRIPTION
  DSH has no persistent Node tool, so this skill runs a background daemon that owns one
  visible Chrome session and one prepared asset cache. Every call here forwards one JSON
  command to that daemon; the daemon starts on first use and keeps Chrome and logins alive
  between turns.

  Log files and the session ID live under $DSH_HOME\ai-literacy-search.
  The Playwright runtime lives under $HOME\.ailiteracy-runtime.

.EXAMPLE
  .\ailit.ps1 health
  .\ailit.ps1 prepare
  .\ailit.ps1 bank-status
  .\ailit.ps1 lookup -QuestionFile .\q.json
  .\ailit.ps1 pages
  .\ailit.ps1 call -Method observe -Args .\args.json
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('health', 'start', 'prepare', 'bank-status', 'lookup', 'search', 'pages', 'open', 'call', 'close', 'shutdown')]
    [string] $Command,

    [string] $QuestionFile,
    [string] $Args,
    [string] $Method,
    [string] $Sources,
    [string] $Recipe,
    [string] $Params,
    [string] $Url,
    [int] $Limit = 3,
    [int] $TimeoutMs = 180000,
    [switch] $NoSources
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The daemon answers UTF-8 JSON. Windows PowerShell otherwise decodes it with the system ANSI
# code page, which turns non-ASCII install paths into mojibake in the printed answer.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch { }

$adapterDir = $PSScriptRoot
$client = Join-Path $adapterDir 'ailit.cjs'
if (-not (Test-Path -LiteralPath $client -PathType Leaf)) { throw "Adapter client is missing: $client" }

# Locate the Playwright runtime in this order: an explicit environment override, the path
# recorded in paths.json by the adapter setup script, the single-path record it also writes,
# then a runtime directory kept beside the sources.
function Resolve-Runtime {
    param([string] $BundleRoot, [string] $AdapterDir)
    if ($env:AI_LITERACY_RUNTIME_DIR) { return $env:AI_LITERACY_RUNTIME_DIR }
    $config = Join-Path $AdapterDir 'paths.json'
    if (Test-Path -LiteralPath $config -PathType Leaf) {
        try {
            $recorded = (Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json).runtimeDir
            if ($recorded) {
                $candidate = [IO.Path]::GetFullPath((Join-Path $AdapterDir $recorded))
                if (Test-Path -LiteralPath (Join-Path $candidate 'node_modules')) { return $candidate }
            }
        } catch { }
    }
    $legacy = Join-Path $AdapterDir 'runtime-path.txt'
    if (Test-Path -LiteralPath $legacy -PathType Leaf) {
        # Read as UTF-8 explicitly: Windows PowerShell 5.1 otherwise decodes the file with the
        # system ANSI code page and corrupts non-ASCII install paths.
        $value = (Get-Content -LiteralPath $legacy -Raw -Encoding UTF8).Trim()
        if ($value -and (Test-Path -LiteralPath (Join-Path $value 'node_modules'))) { return $value }
    }
    $canonical = Join-Path $HOME '.ailiteracy-runtime'
    if ((Test-Path -LiteralPath (Join-Path $canonical 'node_modules')) -and
        (Test-Path -LiteralPath (Join-Path $canonical 'package.json'))) { return $canonical }
    foreach ($candidate in @((Join-Path $BundleRoot 'runtime'), (Join-Path (Split-Path -Parent $BundleRoot) 'runtime'))) {
        if (Test-Path -LiteralPath (Join-Path $candidate 'node_modules')) { return $candidate }
    }
    return $canonical
}

# The skill bundle may sit beside the adapter directory or one level up when the package
# is kept whole (adapter in <package>\_dsh, bundle in <package>\ai-literacy-search).
$bundleCandidates = @(
    (Join-Path $adapterDir '..\ai-literacy-search'),
    (Join-Path $adapterDir '..\ai-information-literacy-search\ai-literacy-search'),
    $adapterDir
)
$bundleRoot = $null
foreach ($candidate in $bundleCandidates) {
    $resolved = [IO.Path]::GetFullPath($candidate)
    if (Test-Path -LiteralPath (Join-Path $resolved 'scripts\browser.cjs')) { $bundleRoot = $resolved; break }
}
if (-not $bundleRoot) { throw 'Cannot locate the skill bundle (scripts/browser.cjs) near the adapter directory.' }

$env:AI_LITERACY_SKILL_ROOT = $bundleRoot
$env:AI_LITERACY_RUNTIME_DIR = Resolve-Runtime -BundleRoot $bundleRoot -AdapterDir $adapterDir

$node = (Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { throw 'Node.js 20+ is required but node.exe was not found on PATH.' }

$arguments = @($client, $Command, '--timeoutMs', $TimeoutMs)
switch ($Command) {
    'prepare' {
        if ($NoSources) { $arguments += '--none' }
        elseif ($Sources) { $arguments += @('--sources', $Sources) }
    }
    'lookup' {
        if (-not $QuestionFile) { throw 'lookup needs -QuestionFile <q.json>.' }
        $arguments += @('--question-file', $QuestionFile, '--limit', $Limit)
    }
    'search' {
        if (-not $QuestionFile) { throw 'search needs -QuestionFile <q.json>.' }
        if (-not $Recipe) { throw 'search needs -Recipe <recipeId>.' }
        $arguments += @('--question-file', $QuestionFile, '--recipe', $Recipe)
        if ($Params) { $arguments += @('--params', $Params) }
    }
    'open' {
        if (-not $Url) { throw 'open needs -Url <url>.' }
        $arguments += @('--url', $Url)
    }
    'call' {
        if (-not $Method) { throw 'call needs -Method <name>.' }
        $arguments += @('--method', $Method)
        if ($Args) { $arguments += @('--args', $Args) }
    }
}

& $node @arguments
exit $LASTEXITCODE
