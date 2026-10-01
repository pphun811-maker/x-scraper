$ErrorActionPreference = 'SilentlyContinue'
$out = @()
$pid0 = 19384
$p = Get-CimInstance Win32_Process -Filter "ProcessId = $pid0"
if ($p) {
  $out += "self: pid=$($p.ProcessId) name=$($p.Name) parent=$($p.ParentProcessId)"
  $p1 = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"
  if ($p1) {
    $out += "mid:   pid=$($p1.ProcessId) name=$($p1.Name) parent=$($p1.ParentProcessId)"
    $p2 = Get-CimInstance Win32_Process -Filter "ProcessId = $($p1.ParentProcessId)"
    if ($p2) { $out += "root:  pid=$($p2.ProcessId) name=$($p2.Name)" }
    else { $out += "root:  (parent process already exited)" }
  } else { $out += "mid: not found" }
} else { $out += "self: pid $pid0 not found" }
$out | Out-File -FilePath (Join-Path $PSScriptRoot '_parent-check.txt') -Encoding utf8
