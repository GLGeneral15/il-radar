<#
.SYNOPSIS
Install only the AI literacy skill without changing Codex configuration or PATH.
.EXAMPLE
./install.ps1 -Target both
.EXAMPLE
./install.ps1 -Target cli -Update
.NOTES
cli: ~/.agents/skills; app: ~/.codex/skills (legacy target names only).
Some clients discover both paths and may show the same skill twice. In that case,
choose one target on future installations and remove only the unused copy yourself.
An existing directory is updated only when this installer manages it. Updates
preserve extra files, reject conflicting edits, and back up prior managed files.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet('cli', 'app', 'both')]
    [string] $Target = 'both',
    [switch] $Update,
    [string] $SkillSource
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$MarkerName = '.ailiteracy-install.json'
$PackageRoot = if ([string]::IsNullOrWhiteSpace($SkillSource)) {
    [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
} else { [IO.Path]::GetFullPath($SkillSource) }
$SkillName = Split-Path -Leaf $PackageRoot
if ($SkillName -ne 'ai-literacy-search') { throw 'This installer installs only ai-literacy-search.' }
$PackageId = 'ai-literacy-search-managed-v1:' + $SkillName
$ProfileRoot = [Environment]::GetFolderPath('UserProfile')
if ([string]::IsNullOrWhiteSpace($ProfileRoot)) {
    throw 'Cannot locate the current user profile.'
}
if (-not (Test-Path -LiteralPath (Join-Path $PackageRoot 'SKILL.md') -PathType Leaf)) {
    throw "Incomplete package: SKILL.md is missing from $PackageRoot"
}

function Get-ReadOnlyFileSHA256 {
    param([string] $LiteralPath)
    # Get-FileHash uses provider operations affected by inherited WhatIf in some
    # Windows PowerShell versions. Direct read-only .NET IO also works in dry runs.
    $stream = [IO.File]::OpenRead($LiteralPath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
    } finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Get-SafeChildPath {
    param([string] $Root, [string] $Relative)
    if ([string]::IsNullOrWhiteSpace($Relative) -or
        [IO.Path]::IsPathRooted($Relative) -or
        $Relative.Contains(':') -or
        (($Relative -split '[\\/]') -contains '..')) {
        throw "Unsafe managed relative path: $Relative"
    }
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]'\/')
    $childFull = [IO.Path]::GetFullPath((Join-Path $rootFull $Relative))
    if (-not $childFull.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar,
            [StringComparison]::OrdinalIgnoreCase)) {
        throw "Managed path escapes the installation: $Relative"
    }
    # Do not write through user-created links or junctions within an installation.
    $cursor = $childFull
    while (-not [string]::IsNullOrWhiteSpace($cursor)) {
        if (Test-Path -LiteralPath $cursor) {
            $entry = Get-Item -LiteralPath $cursor -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing to write through a link or junction: $cursor"
            }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    return $childFull
}

# Deliberate release allowlist: runtime dependencies, profiles, cookies, evidence,
# validation outputs, and historical batch/CLI helpers never enter a skill install.
# Keep this list aligned with validation/package_bundle.py in the source bundle.
$releaseFiles = @(
    'SKILL.md',
    'agents/openai.yaml',
    'references/answer.schema.json',
    'references/browser.md',
    'references/browser-api.md',
    'references/exam-scope.md',
    'references/retrieval.md',
    'references/rules.json',
    'references/question-bank.json',
    'references/question-bank.md',
    'references/rule-evidence/retrieval-metrics.json',
    'references/rule-evidence/retrieval-metrics.png',
    'references/rule-evidence/boolean-operators.json',
    'references/rule-evidence/boolean-operators.png',
    'references/rule-evidence/doi-basics.json',
    'references/rule-evidence/doi-basics-identity.png',
    'references/rule-evidence/doi-basics-persistence.png',
    'references/rule-evidence/doi-basics-resolution.png',
    'references/rule-evidence/isbn-basics.json',
    'references/rule-evidence/isbn-basics-identity.png',
    'references/rule-evidence/isbn-basics-product.png',
    'references/rule-evidence/isbn-basics-formats.png',
    'references/rule-evidence/issn-basics.json',
    'references/rule-evidence/issn-basics-identity.png',
    'references/rule-evidence/issn-basics-format.png',
    'references/rule-evidence/issn-basics-quality.png',
    'references/rule-evidence/inverted-index.json',
    'references/rule-evidence/inverted-index.png',
    'references/recipes.md',
    'references/search-index.json',
    'references/sources.json',
    'scripts/browser.cjs',
    'scripts/question-bank.cjs',
    'scripts/preparation.cjs',
    'scripts/asset-cache.cjs',
    'scripts/local-evidence.cjs',
    'scripts/evidence-reuse.cjs',
    'scripts/search-runner.cjs',
    'scripts/recipes.cjs',
    'scripts/transitions.cjs',
    'scripts/install.ps1',
    'runtime/package.json',
    'runtime/package-lock.json',
    'runtime/repl/README.md',
    'runtime/repl/snippets/bootstrap.js',
    'runtime/repl/snippets/prepare.js'
)
# The index is the only authority for distributed site profiles. Never recurse
# through references/sites: observations, downloaded pages and future user files
# must remain outside the release. Get-SafeChildPath also rejects reparse points.
$indexPath = Get-SafeChildPath -Root $PackageRoot -Relative 'references/search-index.json'
if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    throw 'Incomplete package: references/search-index.json is missing.'
}
$searchIndex = Get-Content -LiteralPath $indexPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $searchIndex.PSObject.Properties['sources'] -or @($searchIndex.sources).Count -eq 0) {
    throw 'Search index must list at least one source profile.'
}
$profilePaths = @{}
foreach ($site in @($searchIndex.sources)) {
    if (-not $site.PSObject.Properties['profile']) {
        throw 'A search index source is missing its profile path.'
    }
    $relative = [string]$site.profile
    if ($relative -cnotmatch '^references/sites/[a-z0-9][a-z0-9-]*\.json$') {
        throw "Unsafe source profile path in search index: $relative"
    }
    if ($profilePaths.ContainsKey($relative)) {
        throw "Duplicate source profile path in search index: $relative"
    }
    $null = Get-SafeChildPath -Root $PackageRoot -Relative $relative
    $profilePaths[$relative] = $true
    $releaseFiles += $relative
}
$sourceFiles = @()
foreach ($relative in $releaseFiles) {
    $source = Get-SafeChildPath -Root $PackageRoot -Relative $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Incomplete package: release file is missing: $relative"
    }
    $sourceFiles += [PSCustomObject]@{
        path = $relative
        sha256 = Get-ReadOnlyFileSHA256 -LiteralPath $source
        source = $source
    }
}
if ($sourceFiles.Count -eq 0) { throw 'The package contains no installable files.' }

$scopes = if ($Target -eq 'both') { @('cli', 'app') } else { @($Target) }
$plans = @()
foreach ($scope in $scopes) {
    $relativeRoot = if ($scope -eq 'cli') { '.agents/skills' } else { '.codex/skills' }
    $skillsRoot = [IO.Path]::GetFullPath((Join-Path $ProfileRoot $relativeRoot))
    $destination = Get-SafeChildPath -Root $skillsRoot -Relative $SkillName
    $markerPath = Get-SafeChildPath -Root $destination -Relative $MarkerName
    $oldFiles = @{}
    $exists = Test-Path -LiteralPath $destination
    if ($exists) {
        if (-not (Test-Path -LiteralPath $destination -PathType Container)) {
            throw "Installation destination is not a directory: $destination"
        }
        if (-not $Update) {
            throw "Already exists: $destination. Use -Update only for a managed installation."
        }
        if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
            throw "Existing skill is not managed by this installer; it will not be overwritten: $destination"
        }
        $marker = Get-Content -LiteralPath $markerPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($marker.package_id -ne $PackageId -or $marker.skill -ne $SkillName -or
            $marker.scope -ne $scope -or
            [IO.Path]::GetFullPath([string]$marker.destination) -ne $destination) {
            throw "The installation marker does not match this destination: $destination"
        }
        foreach ($item in $marker.files) {
            $oldPath = Get-SafeChildPath -Root $destination -Relative ([string]$item.path)
            if ($oldFiles.ContainsKey([string]$item.path)) { throw 'Duplicate path in installation marker.' }
            if ([string]$item.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Invalid hash in installation marker.' }
            $oldFiles[[string]$item.path] = [string]$item.sha256
            if (Test-Path -LiteralPath $oldPath) {
                if (-not (Test-Path -LiteralPath $oldPath -PathType Leaf)) {
                    throw "Managed file has been replaced with a directory: $oldPath"
                }
                if ((Get-ReadOnlyFileSHA256 -LiteralPath $oldPath) -ne $item.sha256) {
                    throw "A managed file was edited. Preserve or restore it before updating: $oldPath"
                }
            }
        }
    }
    foreach ($item in $sourceFiles) {
        $newPath = Get-SafeChildPath -Root $destination -Relative $item.path
        if (Test-Path -LiteralPath $newPath) {
            if (-not (Test-Path -LiteralPath $newPath -PathType Leaf)) {
                throw "A directory conflicts with a package file: $newPath"
            }
            if (-not $oldFiles.ContainsKey($item.path) -and
                (Get-ReadOnlyFileSHA256 -LiteralPath $newPath) -ne $item.sha256) {
                throw "An extra user file conflicts with a new package file: $newPath"
            }
        }
    }
    $plans += [PSCustomObject]@{
        scope = $scope; root = $skillsRoot; destination = $destination
        marker = $markerPath; exists = $exists; old_files = $oldFiles
    }
}

foreach ($plan in $plans) {
    $action = if ($plan.exists) { 'Back up and update managed skill' } else { 'Install skill' }
    if (-not $PSCmdlet.ShouldProcess($plan.destination, $action)) { continue }
    $backupRoot = $null
    if ($plan.exists) {
        $backupName = $SkillName + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' +
            ([Guid]::NewGuid().ToString('N').Substring(0, 8))
        # Keep backups outside skill discovery roots, so an old SKILL.md is not loaded.
        $backupParent = Join-Path $ProfileRoot ('.ailiteracy-backups/' + $plan.scope)
        $backupRoot = Get-SafeChildPath -Root $backupParent -Relative $backupName
        [IO.Directory]::CreateDirectory($backupRoot) | Out-Null
        foreach ($relative in $plan.old_files.Keys) {
            $oldPath = Get-SafeChildPath -Root $plan.destination -Relative $relative
            if (Test-Path -LiteralPath $oldPath -PathType Leaf) {
                $backupPath = Get-SafeChildPath -Root $backupRoot -Relative $relative
                [IO.Directory]::CreateDirectory((Split-Path -Parent $backupPath)) | Out-Null
                Copy-Item -LiteralPath $oldPath -Destination $backupPath
            }
        }
        Copy-Item -LiteralPath $plan.marker -Destination (Join-Path $backupRoot $MarkerName)
    }
    try {
        [IO.Directory]::CreateDirectory($plan.destination) | Out-Null
        $incoming = @{}
        foreach ($item in $sourceFiles) {
            $targetPath = Get-SafeChildPath -Root $plan.destination -Relative $item.path
            [IO.Directory]::CreateDirectory((Split-Path -Parent $targetPath)) | Out-Null
            Copy-Item -LiteralPath $item.source -Destination $targetPath -Force
            $incoming[$item.path] = $true
        }
        foreach ($relative in $plan.old_files.Keys) {
            if (-not $incoming.ContainsKey($relative)) {
                $obsolete = Get-SafeChildPath -Root $plan.destination -Relative $relative
                if (Test-Path -LiteralPath $obsolete -PathType Leaf) {
                    Remove-Item -LiteralPath $obsolete -Force
                }
            }
        }
        $newMarker = [ordered]@{
            package_id = $PackageId; skill = $SkillName; scope = $plan.scope
            destination = $plan.destination; installed_utc = [DateTime]::UtcNow.ToString('o')
            files = @($sourceFiles | ForEach-Object {
                [ordered]@{ path = $_.path; sha256 = $_.sha256 }
            })
        }
        $markerJson = $newMarker | ConvertTo-Json -Depth 5
        [IO.File]::WriteAllText($plan.marker, $markerJson, [Text.UTF8Encoding]::new($false))
    } catch {
        if ($backupRoot) {
            throw "Update failed. Previous managed files remain in $backupRoot. Details: $($_.Exception.Message)"
        }
        throw
    }
    Write-Output "Installed ($($plan.scope)): $($plan.destination)"
    if ($backupRoot) { Write-Output "Previous managed files: $backupRoot" }
}
if ($Target -eq 'both') {
    Write-Warning 'Both compatibility paths were selected. A client that scans both may list this skill twice; choose -Target cli or -Target app when only one path is needed.'
}
Write-Output 'Codex normally detects new skills automatically. Restart the client if the skill does not appear.'
