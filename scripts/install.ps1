# Installs, updates, or uninstalls the standalone OpenChessCoach bundle on Windows
# without requiring Node.js, npm, Git, or administrator privileges.
#
#   irm https://github.com/inprealpha/OpenChessCoach/releases/latest/download/install.ps1 | iex
[CmdletBinding()]
param(
  [string]$Version = 'latest',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'OpenChessCoach'),
  [string]$Archive = '',
  [switch]$NoPath,
  [switch]$NoShortcut,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'inprealpha/OpenChessCoach'
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) 'OpenChessCoach.lnk'

function Assert-NotRunning([string]$Dir) {
  if (-not (Test-Path $Dir)) { return }
  $resolved = (Resolve-Path $Dir).Path.TrimEnd('\') + '\'
  $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.Path -and $_.Path.StartsWith($resolved, [System.StringComparison]::OrdinalIgnoreCase)
  })
  if ($running.Count -gt 0) {
    throw "OpenChessCoach is currently running from $Dir. Close it (press Ctrl+C in its terminal window) and re-run this command."
  }
}

function Expand-ZipFast([string]$ZipPath, [string]$DestDir) {
  New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    & $tar.Source -xf $ZipPath -C $DestDir
    if ($LASTEXITCODE -eq 0) { return }
    Remove-Item -Recurse -Force $DestDir
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
  }
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $DestDir)
    return
  } catch {
    Remove-Item -Recurse -Force $DestDir
    Expand-Archive -Path $ZipPath -DestinationPath $DestDir -Force
  }
}

function Remove-FromUserPath([string]$Dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $current) { return }
  $norm = $Dir.TrimEnd('\').ToLowerInvariant()
  $kept = @($current -split ';' | Where-Object { $_ -and ($_.TrimEnd('\').ToLowerInvariant() -ne $norm) })
  [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
}

function Add-ToUserPath([string]$Dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $norm = $Dir.TrimEnd('\').ToLowerInvariant()
  $parts = @()
  if ($current) { $parts = @($current -split ';' | Where-Object { $_ }) }
  $exists = $parts | Where-Object { $_.TrimEnd('\').ToLowerInvariant() -eq $norm }
  if (-not $exists) {
    $next = if ($parts.Count -gt 0) { ($parts + $Dir) -join ';' } else { $Dir }
    [Environment]::SetEnvironmentVariable('Path', $next, 'User')
  }
  $procParts = @($env:PATH -split ';' | Where-Object { $_ })
  if (-not ($procParts | Where-Object { $_.TrimEnd('\').ToLowerInvariant() -eq $norm })) {
    $env:PATH = "$Dir;$env:PATH"
  }
}

if ($Uninstall) {
  Assert-NotRunning $InstallDir
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  if (-not $NoShortcut -and (Test-Path $ShortcutPath)) { Remove-Item -Force $ShortcutPath }
  if (-not $NoPath) { Remove-FromUserPath $InstallDir }
  $dataDir = Join-Path $env:APPDATA 'ai-chess-coach'
  Write-Host 'OpenChessCoach has been uninstalled.'
  Write-Host "Your games and Player Profile were kept in: $dataDir"
  return
}

Assert-NotRunning $InstallDir

# Stock Windows 10 PowerShell 5.1 can default to TLS 1.0 unless TLS 1.2+ is enabled.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

$archRaw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch -Regex ($archRaw) {
  '^(AMD64|x64)$' { $Target = 'win-x64' }
  '^ARM64$'       { $Target = 'win-arm64' }
  default         { throw "Unsupported Windows architecture: $archRaw. OpenChessCoach requires 64-bit Windows (x64 or ARM64)." }
}

$ArchiveName = "openchesscoach-$Target.zip"
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("occ-install-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

try {
  if ($Archive) {
    $ZipPath = (Resolve-Path $Archive).Path
  } else {
    $BaseUrl = if ($Version -eq 'latest') {
      "https://github.com/$Repo/releases/latest/download"
    } else {
      $Tag = if ($Version.StartsWith('v')) { $Version } else { "v$Version" }
      "https://github.com/$Repo/releases/download/$Tag"
    }
    $ZipPath = Join-Path $TempDir $ArchiveName
    $SumsPath = Join-Path $TempDir 'SHA256SUMS.txt'

    Write-Host "Downloading OpenChessCoach ($Target)..."
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/$ArchiveName" -OutFile $ZipPath
    Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $SumsPath

    $expectedLine = Get-Content $SumsPath | Where-Object { $_ -match ("^([a-fA-F0-9]{64})\s+\*?" + [Regex]::Escape($ArchiveName) + "$") } | Select-Object -First 1
    if (-not $expectedLine) { throw "Could not find checksum for $ArchiveName in SHA256SUMS.txt." }
    $expectedHash = ($expectedLine -split '\s+')[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "Checksum mismatch for $ArchiveName (expected $expectedHash, got $actualHash)."
    }
  }

  $ExtractDir = Join-Path $TempDir 'extract'
  Write-Host 'Extracting OpenChessCoach...'
  Expand-ZipFast $ZipPath $ExtractDir
  $ExtractedRoot = Join-Path $ExtractDir 'openchesscoach'
  if (-not (Test-Path (Join-Path $ExtractedRoot 'openchesscoach.cmd'))) {
    throw 'Archive did not contain openchesscoach/openchesscoach.cmd.'
  }

  $ParentDir = Split-Path -Parent $InstallDir
  if ($ParentDir -and -not (Test-Path $ParentDir)) {
    New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
  }
  $BackupDir = "$InstallDir.old"
  if (Test-Path $BackupDir) { Remove-Item -Recurse -Force $BackupDir }
  if (Test-Path $InstallDir) { Move-Item -Path $InstallDir -Destination $BackupDir }
  try {
    Move-Item -Path $ExtractedRoot -Destination $InstallDir
    if (Test-Path $BackupDir) { Remove-Item -Recurse -Force $BackupDir }
  } catch {
    if (-not (Test-Path $InstallDir) -and (Test-Path $BackupDir)) {
      Move-Item -Path $BackupDir -Destination $InstallDir
    }
    throw
  }

  if (-not $NoPath) { Add-ToUserPath $InstallDir }

  # Create a Start Menu shortcut that keeps the window open if startup exits with an error.
  if (-not $NoShortcut) {
    try {
      $ws = New-Object -ComObject WScript.Shell
      $sc = $ws.CreateShortcut($ShortcutPath)
      $cmdPath = Join-Path $InstallDir 'openchesscoach.cmd'
      $escapedCmdPath = $cmdPath -replace "'", "''"
      $sc.TargetPath = 'powershell.exe'
      $sc.Arguments = "-NoProfile -Command `"& '$escapedCmdPath'; if (`$LASTEXITCODE -ne 0) { Write-Host ''; Read-Host 'Press Enter to close' }`""
      $sc.WorkingDirectory = $InstallDir
      $sc.Description = 'OpenChessCoach'
      $sc.Save()
    } catch {
      # Non-fatal if Start Menu shortcut creation is blocked by policy.
    }
  }

  Write-Host ''
  Write-Host "Installed OpenChessCoach to $InstallDir"
  Write-Host 'You can start it from the Start Menu ("OpenChessCoach") or by running:'
  Write-Host '  openchesscoach'

  $claude = Get-Command claude -ErrorAction SilentlyContinue
  if (-not $claude) {
    $localClaude = @(
      (Join-Path $env:USERPROFILE '.local\bin\claude.exe'),
      (Join-Path $env:USERPROFILE '.claude\local\claude.exe'),
      (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\claude.exe')
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $localClaude) {
      Write-Host ''
      Write-Host 'Next step - install Claude Code and sign in with your Claude Pro/Max account:'
      Write-Host '  irm https://claude.ai/install.ps1 | iex'
      Write-Host 'Then open a new PowerShell window, run "claude" to sign in, and run "openchesscoach".'
    }
  }
} finally {
  if (Test-Path $TempDir) { Remove-Item -Recurse -Force $TempDir }
}
