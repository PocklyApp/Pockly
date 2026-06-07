# Copyright 2026 Pockly contributors
# SPDX-License-Identifier: Apache-2.0

param(
  [string]$Version = $env:POCKLY_DAEMON_VERSION,
  [string]$InstallDir = $env:POCKLY_DAEMON_INSTALL_DIR,
  [string]$BaseUrl = $env:POCKLY_DAEMON_BASE_URL,
  [string]$NexusUrl = $env:POCKLY_NEXUS_URL,
  [string]$LegacyRelayUrl = $env:POCKLY_RELAY_URL
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Version)) { $Version = "latest" }
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA "Pockly\bin" }
if ([string]::IsNullOrWhiteSpace($BaseUrl)) {
  throw "POCKLY_DAEMON_BASE_URL is required. Set it to the daemon release base URL that contains latest/checksums.txt."
}
if ([string]::IsNullOrWhiteSpace($NexusUrl)) { $NexusUrl = $LegacyRelayUrl }
if ([string]::IsNullOrWhiteSpace($NexusUrl)) { $NexusUrl = "http://127.0.0.1:8787" }
$ResolvedNexusUrl = $NexusUrl

function Test-PathLocked {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    $stream.Close()
    return $false
  }
  catch [System.IO.IOException] {
    return $true
  }
}

function Wait-PathUnlocked {
  param(
    [string]$Path,
    [int]$TimeoutSeconds = 10
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-PathLocked -Path $Path)) {
      return
    }
    Start-Sleep -Milliseconds 250
  }
  throw "timed out waiting for $Path to be released by the running daemon"
}

function Stop-InstalledDaemon {
  param([string]$Target)

  $stopped = $false
  if (-not (Test-Path -LiteralPath $Target)) {
    return $false
  }

  $resolvedTarget = [System.IO.Path]::GetFullPath($Target)
  $procs = @(Get-CimInstance Win32_Process -Filter "Name = 'pockly-daemon.exe'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $resolvedTarget)
  })

  if ($procs.Count -gt 0) {
    Write-Host "pockly install: stopping running daemon before upgrade"
    $taskExists = $false
    try {
      $query = & schtasks.exe /Query /TN PocklyDaemon 2>$null
      if ($LASTEXITCODE -eq 0) { $taskExists = $true }
    }
    catch {
      $taskExists = $false
    }
    if ($taskExists) {
      & schtasks.exe /End /TN PocklyDaemon *> $null
    }
    foreach ($proc in $procs) {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $stopped = $true
  }

  Wait-PathUnlocked -Path $Target
  return $stopped
}

function Copy-Binary {
  param(
    [string]$Source,
    [string]$Target
  )

  Wait-PathUnlocked -Path $Target
  try {
    Copy-Item -LiteralPath $Source -Destination $Target -Force
  }
  catch [System.IO.IOException] {
    throw "failed to install $Target because it is still in use. Close running Pockly daemon or wrapper processes and retry. Original error: $($_.Exception.Message)"
  }
}

$arch = switch ($env:PROCESSOR_ARCHITECTURE.ToLowerInvariant()) {
  "amd64" { "amd64" }
  "arm64" { "arm64" }
  default { throw "unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$releaseUrl = "$($BaseUrl.TrimEnd('/'))/$Version"
$checksumsUrl = "$releaseUrl/checksums.txt"

Write-Host "pockly install: resolving $Version for windows/$arch"
$checksumsText = Invoke-RestMethod -Uri $checksumsUrl
$assetName = ($checksumsText -split "`n" | ForEach-Object {
  $parts = $_.Trim() -split "\s+"
  if ($parts.Length -ge 2 -and $parts[1] -match "_windows_${arch}\.zip$") { $parts[1] }
} | Select-Object -First 1)

if (-not $assetName) {
  throw "no windows/$arch archive found in $checksumsUrl"
}

$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pockly-daemon-install-" + [Guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $archivePath = Join-Path $tmp $assetName
  Write-Host "pockly install: downloading $assetName"
  Invoke-WebRequest -Uri "$releaseUrl/$assetName" -OutFile $archivePath

  Write-Host "pockly install: verifying checksum"
  $line = $checksumsText -split "`n" | Where-Object { $_ -match "\s+$([regex]::Escape($assetName))$" } | Select-Object -First 1
  if (-not $line) {
    throw "checksum not found for $assetName"
  }
  $expected = ($line.Trim() -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 $archivePath).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    throw "checksum mismatch for $assetName"
  }

  $extractDir = Join-Path $tmp "extract"
  Expand-Archive -Path $archivePath -DestinationPath $extractDir
  $binary = Get-ChildItem -Path $extractDir -Recurse -Filter "pockly-daemon.exe" | Select-Object -First 1
  if (-not $binary) {
    throw "pockly-daemon.exe not found in $assetName"
  }

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $target = Join-Path $InstallDir "pockly-daemon.exe"
  $stoppedDaemon = Stop-InstalledDaemon -Target $target
  Copy-Binary -Source $binary.FullName -Target $target

  Write-Host "pockly install: installed $target"
  & $target --version

  # Install the Claude wrapper alongside the daemon. Inert until the user opts in
  # via `pockly-daemon enable-remote-control`. Older tarballs may not contain it.
  $wrapper = Get-ChildItem -Path $extractDir -Recurse -Filter "pockly-claude-wrapper.exe" | Select-Object -First 1
  if ($wrapper) {
    $wrapperTarget = Join-Path $InstallDir "pockly-claude-wrapper.exe"
    Copy-Binary -Source $wrapper.FullName -Target $wrapperTarget
    Write-Host "pockly install: installed $wrapperTarget (inactive until enable-remote-control)"
  }

  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (($userPath -split ";") -notcontains $InstallDir) {
    Write-Host "pockly install: add $InstallDir to your user PATH if pockly-daemon is not found"
  }

  if ($env:POCKLY_DAEMON_NO_SETUP -ne "1") {
    Write-Host ""
    Write-Host "pockly install: starting first-run setup"
    Write-Host "pockly install: set POCKLY_DAEMON_NO_SETUP=1 to install without setup"
    & $target setup --nexus-url $ResolvedNexusUrl
  }
  else {
    Write-Host "pockly install: setup skipped because POCKLY_DAEMON_NO_SETUP=1"
    Write-Host "Run manually when ready: $target setup --nexus-url $ResolvedNexusUrl"
    if ($stoppedDaemon) {
      Write-Host "pockly install: restart skipped because setup was skipped"
      Write-Host "Restart manually when ready: schtasks /Run /TN PocklyDaemon"
    }
  }
}
finally {
  Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
