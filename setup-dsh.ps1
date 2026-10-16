<#
.SYNOPSIS
  Install the il-radar skill into a DeepSeek Harness skill root.

.DESCRIPTION
  Installs the skill so this harness can load it. The skill name comes from SKILL.md frontmatter:

    <SkillsRoot>\<SkillName>\SKILL.md              DSH-facing skill definition
    <SkillsRoot>\<SkillName>\daemon.cjs            adapter: persistent Chrome daemon
    <SkillsRoot>\<SkillName>\ailit.cjs             adapter: command client
    <SkillsRoot>\<SkillName>\ailit.ps1             adapter: pwsh entry point
    <SkillsRoot>\<SkillName>\scripts\              runtime (browser.cjs and helpers)
    <SkillsRoot>\<SkillName>\references\           question bank, rules, site profiles
    <SkillsRoot>\<SkillName>\runtime\              pinned Playwright manifest
    <SkillsRoot>\<SkillName>\tools\                bank maintenance utilities

  It also installs the pinned Playwright runtime once and records the resolved paths in
  paths.json. Re-run any time; the script stops a running daemon, replaces the payload, and
  leaves the Chrome profile, session ID and login state untouched.

  Scanned DSH skill roots, by priority: <project>\.dsh\skills, <project>\.agents\skills,
  then $DSH_HOME\skills and $HOME\.agents\skills. The default target is the project root of
  the current directory, or of -ProjectRoot when given.

.EXAMPLE
  .\setup-dsh.ps1
.EXAMPLE
  .\setup-dsh.ps1 -ProjectRoot 'C:\work\my-project'
.EXAMPLE
  .\setup-dsh.ps1 -SkillsRoot "$HOME\.dsh\skills" -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    # Directory holding SKILL.md, scripts\, references\, runtime\ and tools\. Defaults to this script's folder.
    [string] $PackageRoot,
    # DSH skill root to install into. Defaults to <ProjectRoot>\.dsh\skills.
    [string] $SkillsRoot,
    # Project root used to derive SkillsRoot. Defaults to the nearest ancestor containing .git, else the current directory.
    [string] $ProjectRoot,
    # Where the pinned Playwright runtime is installed. Defaults to <SkillsRoot>\..\ai-literacy-runtime.
    [string] $RuntimeRoot,
    # Where the daemon keeps its session id, logs and Chrome output. Defaults beside the package.
    [string] $DaemonStateRoot,
    # Install into the shared user roots instead of the project root.
    [switch] $User
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Resolve the package and read the skill name from its SKILL.md so a renamed skill installs
# under its own name. The repo is flat: scripts/, references/, runtime/, tools/ and the adapter
# files all sit at the package root.
if (-not $PackageRoot) { $PackageRoot = $PSScriptRoot }
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot)
$SkillName = $null
if (Test-Path -LiteralPath (Join-Path $PackageRoot 'SKILL.md')) {
    $frontmatter = (Get-Content -LiteralPath (Join-Path $PackageRoot 'SKILL.md') -Encoding UTF8 -TotalCount 5) -join "`n"
    if ($frontmatter -match '(?m)^name:\s*(\S+)\s*$') { $SkillName = $Matches[1] }
}
if (-not $SkillName) { throw "Cannot read the skill name from $PackageRoot\SKILL.md frontmatter." }

function Resolve-FullPath {
    param([string] $Path)
    return [IO.Path]::GetFullPath($Path)
}

function Find-ProjectRoot {
    param([string] $Start)
    $cursor = Resolve-FullPath $Start
    while ($true) {
        if (Test-Path -LiteralPath (Join-Path $cursor '.git')) { return $cursor }
        $parent = Split-Path -Parent $cursor
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { return (Resolve-FullPath $Start) }
        $cursor = $parent
    }
}

# --- resolve inputs ---------------------------------------------------------------------

$adapterSource = $PackageRoot
$bundleSource = $PackageRoot

# The repo is flat: runtime scripts, skill definition and the adapter all sit at the root, and
# only the items below belong in an installed skill. `_build` and `banks` stay local.
# `runtime` must be copied as well: preparation.cjs reads <bundle>/runtime/package.json.
$adapterFiles = @('daemon.cjs', 'ailit.cjs', 'ailit.ps1')
$payloadDirectories = @('scripts', 'references', 'runtime', 'tools')
if (-not (Test-Path -LiteralPath (Join-Path $adapterSource 'daemon.cjs') -PathType Leaf)) {
    throw "Adapter source is incomplete: $adapterSource\daemon.cjs is missing."
}
if (-not (Test-Path -LiteralPath (Join-Path $bundleSource 'scripts\browser.cjs') -PathType Leaf)) {
    throw "Skill payload is incomplete: $bundleSource\scripts\browser.cjs is missing."
}
if (-not (Test-Path -LiteralPath (Join-Path $bundleSource 'references\question-bank.json') -PathType Leaf)) {
    throw "Question bank is missing: $bundleSource\references\question-bank.json"
}

if (-not $ProjectRoot) { $ProjectRoot = Find-ProjectRoot -Start (Get-Location).Path }
$ProjectRoot = Resolve-FullPath $ProjectRoot

if ($User) {
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
    if (-not $SkillsRoot) { $SkillsRoot = Join-Path $dshHome 'skills' }
}
if (-not $SkillsRoot) { $SkillsRoot = Join-Path $ProjectRoot '.dsh\skills' }
$SkillsRoot = Resolve-FullPath $SkillsRoot

$target = Join-Path $SkillsRoot $SkillName
# The adapter lives at the skill root beside scripts/ and references/, matching the repo layout.
$targetAdapter = $target

# Runtime and daemon state hang off the package, not off a possibly linked skill root, so a
# workspace junction cannot drag them onto the wrong drive.
$packageRootFull = [IO.Path]::GetFullPath($PackageRoot)
$packageHome = [IO.Path]::GetFullPath((Split-Path -Parent $packageRootFull))
if (-not $RuntimeRoot) { $RuntimeRoot = Join-Path $packageHome '.dsh\ai-literacy-runtime' }
$RuntimeRoot = Resolve-FullPath $RuntimeRoot
if (-not $DaemonStateRoot) { $DaemonStateRoot = Join-Path $packageHome 'ai-literacy-search' }
$DaemonStateRoot = Resolve-FullPath $DaemonStateRoot

# --- preconditions ----------------------------------------------------------------------

$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npmCommand = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCommand -or -not $npmCommand) { throw 'Install Node.js 20+ with npm first.' }
$nodeExe = $nodeCommand.Path
$npmExe = $npmCommand.Path
$nodeVersion = & $nodeExe --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(\d+)\.') { throw 'Cannot determine the Node.js version.' }
if ([int]$Matches[1] -lt 20) { throw "Node.js 20+ is required; found $nodeVersion." }

$chrome = @(
    (Join-Path ${env:ProgramFiles} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $chrome) { Write-Warning 'Google Chrome was not found in a standard location; browser operations will fail until it is installed.' }

Write-Output "Package:   $PackageRoot"
Write-Output "Install to: $target"
Write-Output "Runtime:   $RuntimeRoot"
Write-Output "Node:      $nodeVersion"

# --- stop a running daemon so adapter files can be replaced -----------------------------

$oldClient = Join-Path $targetAdapter 'ailit.cjs'
if (Test-Path -LiteralPath $oldClient -PathType Leaf) {
    try {
        $null = & $nodeExe $oldClient shutdown 2>&1
        Write-Output 'Stopped the running daemon (Chrome profile and logins are preserved).'
    } catch {
        Write-Output "No running daemon to stop ($($_.Exception.Message))."
    }
}

# --- install ----------------------------------------------------------------------------

if (-not $PSCmdlet.ShouldProcess($target, 'Install the DSH skill adapter')) {
    Write-Output 'WhatIf complete: nothing was written.'
    return
}

foreach ($directory in @($targetAdapter, $RuntimeRoot)) {
    [IO.Directory]::CreateDirectory($directory) | Out-Null
}

# Resolve a path relative to the package when it lives inside it, so the recorded configuration
# stays valid if the package (or a linking skill root) is moved.
function Get-RelativeOrAbsolute {
    param([string] $Base, [string] $Path)
    $baseFull = [IO.Path]::GetFullPath($Base).TrimEnd('\') + '\'
    $pathFull = [IO.Path]::GetFullPath($Path)
    if ($pathFull.StartsWith($baseFull, [StringComparison]::OrdinalIgnoreCase)) {
        return $pathFull.Substring($baseFull.Length)
    }
    return $pathFull
}

# Adapter files (small, owned by this package) plus the DSH-facing skill definition.
foreach ($name in $adapterFiles) {
    Copy-Item -LiteralPath (Join-Path $adapterSource $name) -Destination (Join-Path $targetAdapter $name) -Force
}
Copy-Item -LiteralPath (Join-Path $adapterSource 'SKILL.md') -Destination (Join-Path $target 'SKILL.md') -Force

# Record the resolved locations for the wrapper and the daemon, relative to the package so the
# configuration stays valid if the package (or a linking skill root) is moved.
#
# Written here, immediately after the adapter lands, and deliberately before the Playwright step:
# if a caller pipes this script's output into Select-Object or Select-String, PowerShell can stop
# the script early. Anything written after the first such output would then be skipped, leaving a
# half-installed skill. Keeping the configuration writes early makes that failure mode harmless.
$packageLocationBase = [IO.Path]::GetFullPath($PackageRoot)
$pathsConfig = [ordered]@{
    runtimeDir = Get-RelativeOrAbsolute -Base $packageLocationBase -Path $RuntimeRoot
    daemonDir  = Get-RelativeOrAbsolute -Base $packageLocationBase -Path $DaemonStateRoot
}
[IO.File]::WriteAllText((Join-Path $targetAdapter 'paths.json'),
    ($pathsConfig | ConvertTo-Json -Depth 3) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $targetAdapter 'runtime-path.txt'),
    $RuntimeRoot + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

# Skill payload: only the directories the runtime needs. _build, banks and .git stay out.
$payloadCount = 0
foreach ($directory in $payloadDirectories) {
    $sourceDirectory = Join-Path $bundleSource $directory
    if (-not (Test-Path -LiteralPath $sourceDirectory)) { continue }
    foreach ($file in Get-ChildItem -LiteralPath $sourceDirectory -Recurse -File -Force) {
        $relative = $file.FullName.Substring($bundleSource.Length).TrimStart('\')
        if ($relative -match '^references\\runtime\\repl\\') { continue }
        $destination = Join-Path $target $relative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
        $payloadCount += 1
    }
}
Write-Output "Copied $payloadCount skill files."

# Pinned Playwright runtime, installed once and shared by re-installs.
$runtimeManifest = Join-Path $RuntimeRoot 'package.json'
$runtimeReady = (Test-Path -LiteralPath (Join-Path $RuntimeRoot 'node_modules\playwright')) -and
    (Test-Path -LiteralPath $runtimeManifest -PathType Leaf)
if (-not $runtimeReady) {
    foreach ($name in @('package.json', 'package-lock.json')) {
        Copy-Item -LiteralPath (Join-Path (Join-Path $bundleSource 'runtime') $name) -Destination (Join-Path $RuntimeRoot $name) -Force
    }
    Write-Output 'Installing the pinned Playwright runtime (browser download is skipped; local Chrome is used)...'
    $previousSkip = [Environment]::GetEnvironmentVariable('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', 'Process')
    Push-Location -LiteralPath $RuntimeRoot
    try {
        [Environment]::SetEnvironmentVariable('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', '1', 'Process')
        # npm is a batch shim: Start-Process passes arguments without PowerShell rebinding them.
        $npmProcess = Start-Process -FilePath $npmExe -ArgumentList @('ci', '--ignore-scripts', '--no-audit', '--no-fund') -WorkingDirectory $RuntimeRoot -NoNewWindow -Wait -PassThru
        if ($npmProcess.ExitCode -ne 0) { throw "Playwright runtime installation failed with exit code $($npmProcess.ExitCode)." }
    } finally {
        Pop-Location
        [Environment]::SetEnvironmentVariable('PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD', $previousSkip, 'Process')
    }
} else {
    Write-Output 'Playwright runtime already present; reused.'
}

# The daemon state directory is created here; the location records were written earlier, before
# the first output that a pipeline could cut short.
[IO.Directory]::CreateDirectory($DaemonStateRoot) | Out-Null
Write-Output "Daemon state: $DaemonStateRoot"

# --- verify -----------------------------------------------------------------------------

$wrapper = Join-Path $targetAdapter 'ailit.ps1'
# Prefer the PowerShell that is running this script; Start-Process needs quotes around paths
# that contain spaces, so the wrapper path is quoted explicitly.
$powerShell = if ($PSVersionTable.PSEdition -eq 'Core') { 'pwsh.exe' } else { 'powershell.exe' }
$powerShellCommand = Get-Command $powerShell -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($powerShellCommand) { $powerShell = $powerShellCommand.Path }
if ($powerShell) {
    Write-Output 'Verifying the installed skill...'
    $verifyLog = Join-Path ([IO.Path]::GetTempPath()) ('ailit-verify-' + [Guid]::NewGuid().ToString('N') + '.txt')
    try {
        $verify = Start-Process -FilePath $powerShell -ArgumentList @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $wrapper + '"'), 'health'
        ) -NoNewWindow -PassThru -RedirectStandardOutput $verifyLog -RedirectStandardError "$verifyLog.err"
        if (-not $verify.WaitForExit(90000)) {
            try { Stop-Process -Id $verify.Id -Force -ErrorAction SilentlyContinue } catch { }
            throw "The installed skill did not answer a health check within 90 s; see the daemon log under $daemonStateRoot."
        }
        $report = ((Get-Content -LiteralPath $verifyLog -Raw -ErrorAction SilentlyContinue) + '').Trim()
        Write-Output $report
        if ($report -notmatch '"ok":\s*true') {
            $errors = ((Get-Content -LiteralPath "$verifyLog.err" -Raw -ErrorAction SilentlyContinue) + '').Trim()
            if ($errors) { Write-Output $errors }
            throw 'Installed skill did not answer a health check; see the daemon log.'
        }
    } finally {
        Remove-Item -LiteralPath $verifyLog, "$verifyLog.err" -Force -ErrorAction SilentlyContinue
    }
}

Write-Output ''
Write-Output "Installed: $target"
Write-Output "Skill file: $(Join-Path $target 'SKILL.md')"
Write-Output 'Open a new DSH turn if the skill does not appear in the catalog immediately.'
