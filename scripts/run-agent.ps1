<#
.SYNOPSIS
    Chạy sessionmon-agent, ghi log, tự chạy lại khi agent thoát. Scheduled Task "SessionMon Agent" gọi tệp này
    qua `conhost.exe --headless` để không có cửa sổ.
#>
param(
    [Parameter(Mandatory)][string]$Bun
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root 'agent.log'

function Write-Log([string]$Text) {
    Add-Content -LiteralPath $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Text" -Encoding UTF8
}

Set-Location -LiteralPath $root
$out = Join-Path $root 'agent.out.log'
$err = Join-Path $root 'agent.err.log'
while ($true) {
    # Giữ log gọn: quá 1 MB thì bắt đầu lại.
    if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 1MB) { Remove-Item -LiteralPath $log }
    Write-Log 'khởi động agent'
    # Start-Process ghi nguyên byte UTF-8 của Bun; còn `>>` của PowerShell 5.1 sẽ đổi sang UTF-16.
    $p = Start-Process -FilePath $Bun -ArgumentList 'run', 'src/agent.ts' -WorkingDirectory $root -NoNewWindow -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $null = $p.Handle  # giữ handle thì mới đọc được ExitCode sau khi thoát
    $p.WaitForExit()
    $tail = if (Test-Path -LiteralPath $err) { (Get-Content -LiteralPath $err -Tail 5 -Encoding UTF8) -join ' | ' } else { '' }
    Write-Log "agent thoát (mã $($p.ExitCode)) $tail"
    Start-Sleep -Seconds 5
}
