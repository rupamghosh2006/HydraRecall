param(
  [string]$RunId = "hydrarecall-lme-s",
  [int]$TopK = 8,
  [int]$PaceMs = 4000,
  [switch]$SyncHydra,
  [string]$Input = "data/longmemeval/longmemeval_s_cleaned.json",
  [string]$Endpoint = "http://127.0.0.1:3000"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path $root "runs\longmemeval\$RunId.stdout.log"
$err = Join-Path $root "runs\longmemeval\$RunId.stderr.log"
$args = @(
  "scripts/longmemeval-adapter.mjs",
  "--input", $Input,
  "--top-k", "$TopK",
  "--run-id", $RunId,
  "--resume",
  "--pace-ms", "$PaceMs",
  "--endpoint", $Endpoint
)
if ($SyncHydra) { $args += "--sync-hydra" }
$p = Start-Process -FilePath "node" -ArgumentList $args -WorkingDirectory $root `
  -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
Set-Content -Path (Join-Path $root "runs\longmemeval\$RunId.pid") -Value $p.Id
"Started $RunId (PID $($p.Id)) -> $out"
