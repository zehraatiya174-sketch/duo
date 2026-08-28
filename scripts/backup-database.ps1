<#
.SYNOPSIS
  Takes a compressed snapshot of the Duo database and prunes old ones.

.DESCRIPTION
  A database on this PC is fast because it is close, and vulnerable for exactly
  the same reason: there is no provider keeping a copy. This is what replaces
  that. It is the only thing standing between a failed disk and losing the
  conversation, so it is worth running on a schedule - see `Install-Schedule`
  below, or the README.

  `pg_dump -Fc` writes the custom format: compressed, and restorable selectively
  with pg_restore rather than only as one all-or-nothing script.

  A dump is verified after it is written. An unreadable backup discovered during
  a restore is worse than no backup, because it was trusted in the meantime.

.PARAMETER Keep
  How many snapshots to retain. Older ones are deleted after a successful run.

.PARAMETER InstallSchedule
  Registers a daily task under the current user, so this runs without anyone
  remembering to. Needs no administrator rights.

.EXAMPLE
  ./scripts/backup-database.ps1
  ./scripts/backup-database.ps1 -InstallSchedule
#>
[CmdletBinding()]
param(
  [int]$Keep = 14,
  [switch]$InstallSchedule
)

$ErrorActionPreference = 'Stop'

$Root = Join-Path $env:LOCALAPPDATA 'Duo\postgres'
$BinDir = Join-Path $Root 'pgsql\bin'
$BackupDir = Join-Path $Root 'backups'

if ($InstallSchedule) {
  $script = $MyInvocation.MyCommand.Path
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
  $trigger = New-ScheduledTaskTrigger -Daily -At 3am
  # StartWhenAvailable so a machine that was off at 3am still catches up rather
  # than silently skipping the day.
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
    -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries

  Register-ScheduledTask -TaskName 'Duo database backup' -Action $action `
    -Trigger $trigger -Settings $settings -Force | Out-Null

  Write-Host 'Scheduled: daily at 03:00.'
  return
}

# The connection string is the app's own, so there is one place to change it.
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
if (-not (Test-Path $envFile)) { throw "No .env at $envFile" }

$line = Select-String -Path $envFile -Pattern '^DATABASE_URL_UNPOOLED=(.+)$' |
  Select-Object -First 1
if (-not $line) {
  $line = Select-String -Path $envFile -Pattern '^DATABASE_URL=(.+)$' | Select-Object -First 1
}
if (-not $line) { throw 'No DATABASE_URL in .env' }

$url = $line.Matches[0].Groups[1].Value.Trim().Trim('"')

# Prisma understands query parameters libpq has never heard of, and pg_dump
# rejects the whole URI rather than ignoring one it does not know. Stripping
# them keeps a single connection string in .env instead of a second one that
# could drift out of step with the first.
$prismaOnly = @(
  'schema', 'connection_limit', 'pool_timeout', 'pgbouncer',
  'socket_timeout', 'statement_cache_size', 'sslidentity', 'sslpassword'
)
$split = $url -split '\?', 2
if ($split.Count -eq 2) {
  $kept = $split[1] -split '&' | Where-Object {
    $name = ($_ -split '=', 2)[0]
    $name -and ($prismaOnly -notcontains $name)
  }
  $url = if ($kept) { "$($split[0])?$($kept -join '&')" } else { $split[0] }
}

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$target = Join-Path $BackupDir "duo_$stamp.dump"

$pgDump = Join-Path $BinDir 'pg_dump.exe'
if (-not (Test-Path $pgDump)) { throw "pg_dump is missing from $BinDir" }

& $pgDump --format=custom --compress=9 --no-owner --no-privileges --file=$target $url
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

# Reading the table of contents back proves the file is a dump and not a
# truncated write.
& (Join-Path $BinDir 'pg_restore.exe') --list $target *> $null
if ($LASTEXITCODE -ne 0) {
  Remove-Item $target -Force -ErrorAction SilentlyContinue
  throw 'The dump could not be read back and was discarded.'
}

$size = [math]::Round((Get-Item $target).Length / 1MB, 2)
Write-Host "Backed up to $target ($size MB)"

# Pruned only after a good dump, so a run of failures cannot age out every
# copy that still works.
Get-ChildItem $BackupDir -Filter 'duo_*.dump' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $Keep |
  ForEach-Object {
    Remove-Item $_.FullName -Force
    Write-Host "Removed old backup $($_.Name)"
  }
