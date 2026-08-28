<#
.SYNOPSIS
  Runs Duo's database on this machine.

.DESCRIPTION
  The app is served from this PC through a Cloudflare tunnel, so a database in
  another continent charges a network round trip for every query. Measured from
  here that was 207 ms to Neon's us-east-2, which a page of messages paid
  several times over. Locally it is under a millisecond, and there is no
  free-tier cold start to wake from.

  Deliberately not a Windows service: installing one needs administrator rights,
  and the rest of the stack (the Next server, the tunnel) already runs as
  ordinary user processes for the length of a session. This matches that.

  Every action is idempotent - running `setup` twice will not destroy a cluster
  that already exists, and `start` on a running server is a no-op.

.PARAMETER Action
  setup    Initialise the cluster and create the role and database. Safe to re-run.
  start    Start the server if it is not already running.
  stop     Stop the server.
  status   Report whether the server is up, and on which port.
  psql     Open an interactive shell against the Duo database.

.EXAMPLE
  ./scripts/local-postgres.ps1 start
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'start', 'stop', 'status', 'psql')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'

$Root = Join-Path $env:LOCALAPPDATA 'Duo\postgres'
$BinDir = Join-Path $Root 'pgsql\bin'
$DataDir = Join-Path $Root 'data'
$LogFile = Join-Path $Root 'server.log'
# 5433, not the default 5432.
#
# A stale `embedded-postgres` from the test tooling holds 5432, and its binaries
# live under node_modules where an `npm install` can prune them out from under
# the running process - leaving a postmaster that accepts connections and then
# fails every one. Standing clear of that port means this cluster cannot be
# caught by it, and nothing has to be shut down to get started.
$Port = 5433
$DbName = 'duo'
$DbUser = 'duo'

function Get-Tool([string]$name) {
  $path = Join-Path $BinDir "$name.exe"
  if (-not (Test-Path $path)) {
    throw "PostgreSQL binaries are missing from $BinDir. Run the setup step in the README first."
  }
  return $path
}

<#
  Runs psql and fails if it did.

  Without the exit-code check a failed statement looks identical to a successful
  one - which is how a first run reported "Created role duo" while every command
  in it was being refused.
#>
function Invoke-Psql {
  param([string]$Database = 'postgres', [string]$Sql, [switch]$Scalar)

  $psql = Get-Tool 'psql'
  $arguments = @('-U', 'postgres', '-h', 'localhost', '-p', $Port, '-d', $Database, '-v', 'ON_ERROR_STOP=1')
  if ($Scalar) { $arguments += '-tAc' } else { $arguments += '-c' }
  $arguments += $Sql

  $output = & $psql @arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed: $output"
  }
  return ($output | Out-String).Trim()
}

function Test-Running {
  if (-not (Test-Path (Join-Path $DataDir 'postmaster.pid'))) { return $false }
  & (Get-Tool 'pg_ctl') status -D $DataDir *> $null
  return $LASTEXITCODE -eq 0
}

switch ($Action) {
  'setup' {
    if (Test-Path (Join-Path $DataDir 'PG_VERSION')) {
      Write-Host "Cluster already initialised at $DataDir"
    }
    else {
      $password = $env:DUO_PG_PASSWORD
      if (-not $password) { throw 'Set DUO_PG_PASSWORD before running setup.' }

      New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
      $pwFile = Join-Path $Root 'initpw.tmp'
      # Passed in a file rather than on the command line: an argument is visible
      # to anything that can list processes.
      Set-Content -Path $pwFile -Value $password -NoNewline -Encoding utf8

      try {
        & (Get-Tool 'initdb') -D $DataDir -U postgres --pwfile=$pwFile `
          --auth-local=scram-sha-256 --auth-host=scram-sha-256 --encoding=UTF8 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
      }
      finally {
        Remove-Item $pwFile -Force -ErrorAction SilentlyContinue
      }

      # Loopback only. This database holds two people's private messages and has
      # no reason to accept a connection from the network; the app reaches it
      # over localhost and the tunnel only ever exposes the web server.
      Add-Content -Path (Join-Path $DataDir 'postgresql.conf') -Value @"

# --- Duo ---
listen_addresses = 'localhost'
port = $Port
"@
    }

    if (-not (Test-Running)) {
      & (Get-Tool 'pg_ctl') start -D $DataDir -l $LogFile -w
      if ($LASTEXITCODE -ne 0) {
        throw "The server would not start. Its log is at $LogFile"
      }
    }

    $env:PGPASSWORD = $env:DUO_PG_PASSWORD

    if ((Invoke-Psql -Scalar -Sql "SELECT 1 FROM pg_roles WHERE rolname = '$DbUser'") -ne '1') {
      $escaped = $env:DUO_PG_PASSWORD.Replace("'", "''")
      Invoke-Psql -Sql "CREATE ROLE $DbUser LOGIN PASSWORD '$escaped'" | Out-Null
      Write-Host "Created role $DbUser"
    }

    if ((Invoke-Psql -Scalar -Sql "SELECT 1 FROM pg_database WHERE datname = '$DbName'") -ne '1') {
      Invoke-Psql -Sql "CREATE DATABASE $DbName OWNER $DbUser" | Out-Null
      Write-Host "Created database $DbName"
    }

    # Prisma creates and drops types and tables when it applies a migration, so
    # the owning role needs the schema itself, not just the database.
    Invoke-Psql -Database $DbName -Sql "ALTER SCHEMA public OWNER TO $DbUser" | Out-Null

    Write-Host "Ready on localhost:$Port"
  }

  'start' {
    if (Test-Running) { Write-Host "Already running on port $Port"; break }
    & (Get-Tool 'pg_ctl') start -D $DataDir -l $LogFile -w
    Write-Host "Started on localhost:$Port"
  }

  'stop' {
    if (-not (Test-Running)) { Write-Host 'Not running'; break }
    & (Get-Tool 'pg_ctl') stop -D $DataDir -m fast -w
    Write-Host 'Stopped'
  }

  'status' {
    if (Test-Running) { Write-Host "Running on localhost:$Port" }
    else { Write-Host 'Not running' }
  }

  'psql' {
    $env:PGPASSWORD = $env:DUO_PG_PASSWORD
    & (Get-Tool 'psql') -U $DbUser -h localhost -p $Port -d $DbName
  }
}
