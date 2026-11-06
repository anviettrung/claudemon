<#
.SYNOPSIS
    Cài ClaudeMon cho máy hiện tại: Bun, thư viện, Scheduled Task chạy agent lúc đăng nhập, `tailscale serve`.
.DESCRIPTION
    Chạy bằng install.cmd (nháy đúp) hoặc powershell -File install.ps1. Chạy lặp lại được, không hỏi gì, không mở cửa sổ.
    Agent chỉ bị khởi động lại khi mã trong kho đổi và không có session nào đang chạy.
#>
param(
    [string]$UserHome = ''
)

$ErrorActionPreference = 'Stop'
if (-not $UserHome) { $UserHome = [Environment]::GetFolderPath('UserProfile') }

$Root = $PSScriptRoot
$RepoRoot = $Root
$TaskName = 'ClaudeMon Agent'
$StateFile = Join-Path $UserHome '.claudemon\claudemon-tree.txt'
$Config = Get-Content -LiteralPath (Join-Path $Root 'machines.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Port = [int]$Config.port
$Self = @($Config.machines | Where-Object { $_.computer -ieq $env:COMPUTERNAME })[0]

function Say([string]$Text) { Write-Output "claudemon: $Text" }
function Fail([string]$Text) { Write-Output "claudemon: $Text"; exit 1 }

# --- 1. Bun ---------------------------------------------------------------------------------------
function Find-Bun {
    $cmd = Get-Command bun -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe'),
        (Join-Path $UserHome '.bun\bin\bun.exe')
    ) + @(Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Oven-sh.Bun_*\*\bun.exe') -ErrorAction SilentlyContinue |
            ForEach-Object FullName)
    foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
    return $null
}

$Bun = Find-Bun
if (-not $Bun) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail 'chưa có Bun và không có winget để cài' }
    & winget install --id Oven-sh.Bun -e --silent --accept-source-agreements --accept-package-agreements | Out-Null
    $Bun = Find-Bun
    if (-not $Bun) { Fail 'cài Bun bằng winget xong vẫn không thấy bun.exe' }
    Say "đã cài Bun ($Bun)"
}

# --- 2. Thư viện -----------------------------------------------------------------------------------
$marker = Join-Path $Root 'node_modules\.claudemon-installed'
$lock = Join-Path $Root 'bun.lock'
$needInstall = -not (Test-Path -LiteralPath $marker) -or
    ((Get-Item -LiteralPath $lock).LastWriteTimeUtc -gt (Get-Item -LiteralPath $marker).LastWriteTimeUtc)
if ($needInstall) {
    Push-Location -LiteralPath $Root
    try {
        $out = & $Bun install --frozen-lockfile 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { Fail "bun install lỗi: $($out.Trim())" }
    } finally { Pop-Location }
    Set-Content -LiteralPath $marker -Value (Get-Date -Format o)
    Say 'đã cài thư viện'
}

# --- 3. Scheduled Task ---------------------------------------------------------------------------
# conhost --headless chạy PowerShell mà không hiện cửa sổ nào.
$runner = Join-Path $Root 'scripts\run-agent.ps1'
$taskArgs = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Bun `"$Bun`""
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument $taskArgs -WorkingDirectory $Root
$user = "$env:USERDOMAIN\$env:USERNAME"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$same = $existing -and $existing.Actions.Count -eq 1 -and $existing.Actions[0].Execute -eq 'conhost.exe' -and $existing.Actions[0].Arguments -eq $taskArgs
if (-not $same) {
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description 'claudemon-agent: điều khiển session Claude Code từ xa (kho claudemon)' -Force | Out-Null
    Say "đã đăng ký Scheduled Task '$TaskName'"
}

# --- 4. Chạy hoặc khởi động lại agent ------------------------------------------------------------
function Get-AgentProcessId {
    $c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return [int]$c.OwningProcess } else { return $null }
}

$tree = (& git -C $RepoRoot rev-parse 'HEAD^{tree}' 2>$null)
$lastTree = if (Test-Path -LiteralPath $StateFile) { (Get-Content -LiteralPath $StateFile -Raw).Trim() } else { '' }
$taskRunning = (Get-ScheduledTask -TaskName $TaskName).State -eq 'Running'
$agentPid = Get-AgentProcessId

$live = @()
if ($agentPid -and -not ($taskRunning -and $tree -eq $lastTree)) {
    try { $live = @((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/sessions" -TimeoutSec 5) | Where-Object { $_.live }) } catch {}
}

if ($agentPid -and $taskRunning -and $tree -eq $lastTree) {
    # Đang chạy đúng bản mới nhất.
} elseif ($live.Count) {
    # Hoãn khởi động lại, nhưng vẫn làm tiếp các bước sau (shortcut, Tailscale).
    Say "có $($live.Count) session đang chạy nên chưa khởi động lại agent; lần cài sau sẽ làm"
} else {
    # Dừng cả task, vòng lặp run-agent.ps1 cũ (để nạp lại bản mới) lẫn agent đang giữ cổng:
    # dừng task chỉ tắt conhost, không kéo theo các tiến trình con.
    if ($taskRunning) { Stop-ScheduledTask -TaskName $TaskName }
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
        Where-Object { $_.CommandLine -like '*claudemon*run-agent.ps1*' -and $_.ProcessId -ne $PID } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($agentPid) { Stop-Process -Id $agentPid -Force -ErrorAction SilentlyContinue }
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-AgentProcessId) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    Start-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Get-AgentProcessId) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
    if (-not (Get-AgentProcessId)) { Fail "agent không lên ở cổng $Port, xem $(Join-Path $Root 'agent.log')" }
    if ($tree) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StateFile) | Out-Null; Set-Content -LiteralPath $StateFile -Value $tree }
    Say "agent đã chạy ở http://127.0.0.1:$Port"
}

# --- 5. Shortcut ngoài Desktop và Start Menu ------------------------------------------------------
# Mở ClaudeMon thành cửa sổ riêng như app (Chrome --app, không có Chrome thì Edge), icon ngôi sao. Chỉ ghi lại khi khác đi.
function Find-Browser {
    foreach ($exe in 'chrome.exe', 'msedge.exe') {
        foreach ($hive in 'HKLM:', 'HKCU:') {
            $p = (Get-ItemProperty "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe" -ErrorAction SilentlyContinue).'(default)'
            if ($p -and (Test-Path -LiteralPath $p)) { return $p }
        }
    }
    return $null
}

# Đọc/ghi System.AppUserModel.ID của tệp .lnk (WScript.Shell không làm được việc này).
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ClaudeMonLnkAppId {
    [StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Sequential)] struct PropVariant { public ushort vt; ushort r1, r2, r3; public IntPtr p; IntPtr p2; }
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PropKey k); void GetValue(ref PropKey k, out PropVariant v); void SetValue(ref PropKey k, ref PropVariant v); void Commit(); }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bc, int flags, ref Guid riid, out IPropertyStore ps);
    static PropKey Key = new PropKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    static IPropertyStore Open(string path, int flags) { var g = typeof(IPropertyStore).GUID; IPropertyStore ps; SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, flags, ref g, out ps); return ps; }
    public static string Get(string path) {
        var ps = Open(path, 0); var k = Key; PropVariant v; ps.GetValue(ref k, out v);
        string s = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : ""; Marshal.ReleaseComObject(ps); return s;
    }
    public static void Set(string path, string id) {
        var ps = Open(path, 2); var k = Key; var v = new PropVariant { vt = 31, p = Marshal.StringToCoTaskMemUni(id) };
        try { ps.SetValue(ref k, ref v); ps.Commit(); } finally { Marshal.FreeCoTaskMem(v.p); Marshal.ReleaseComObject(ps); }
    }
}
'@

$browser = Find-Browser
if ($browser) {
    # Thư mục người dùng thật thì hỏi Windows (Desktop có thể bị OneDrive chuyển chỗ); thư mục giả để thử thì ghép tay.
    $realHome = [Environment]::GetFolderPath('UserProfile')
    $isReal = $UserHome -ieq $realHome
    $desktop = if ($isReal) { [Environment]::GetFolderPath('Desktop') } else { Join-Path $UserHome 'Desktop' }
    $startMenu = if ($isReal) { [Environment]::GetFolderPath('Programs') } else { Join-Path $UserHome 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs' }
    # Cửa sổ --app mang AppUserModelID "<Chrome|MSEdge>.<host>_<path>" (bỏ cổng; profile Default thì không thêm hậu tố).
    # Shortcut khai đúng ID này và nằm trong Start Menu thì taskbar mới lấy icon ngôi sao, và pin cửa sổ sẽ pin chính
    # shortcut này. Thiếu nó thì taskbar dùng icon chrome.exe, và bấm pin chỉ pin Chrome.
    # Ghim profile Default để ID không đổi theo profile Chrome dùng gần nhất.
    $appArgs = "--profile-directory=Default --app=http://127.0.0.1:$Port/"
    $appId = $(if ((Split-Path -Leaf $browser) -ieq 'msedge.exe') { 'MSEdge' } else { 'Chrome' }) + '.127.0.0.1_/'
    $icon = Join-Path $Root 'claudemon.ico'
    $shell = New-Object -ComObject WScript.Shell
    # Đã cài ClaudeMon thành app thật (PWA, Chrome tự tạo shortcut "--app-id=..." trong "Chrome Apps"/"Edge Apps") thì dùng
    # app đó: chỉ PWA mới đọc manifest (thanh tiêu đề theo theme, Window Controls Overlay). Gỡ shortcut --app của mình
    # (chỉ gỡ shortcut có "--app=", không đụng shortcut Chrome tạo) và không tạo lại.
    $pwa = Get-ChildItem -LiteralPath $startMenu -Recurse -Filter 'ClaudeMon*.lnk' -ErrorAction SilentlyContinue |
        Where-Object { $_.DirectoryName -match '(Chrome|Edge) Apps' -and $shell.CreateShortcut($_.FullName).Arguments -match '--app-id=' } |
        Select-Object -First 1
    $places = @(@{ Dir = $desktop; Name = 'Desktop' }, @{ Dir = $startMenu; Name = 'Start Menu' })
    if ($pwa) {
        foreach ($place in $places) {
            $lnk = Join-Path $place.Dir 'ClaudeMon.lnk'
            if ((Test-Path -LiteralPath $lnk) -and $shell.CreateShortcut($lnk).Arguments -match '--app=') {
                Remove-Item -LiteralPath $lnk -Force
                Say "đã gỡ shortcut --app cũ ở $($place.Name) (đã có app ClaudeMon cài từ trình duyệt)"
            }
        }
        $places = @()
    }
    foreach ($place in $places) {
        New-Item -ItemType Directory -Force -Path $place.Dir | Out-Null
        $lnk = Join-Path $place.Dir 'ClaudeMon.lnk'
        $exists = Test-Path -LiteralPath $lnk
        $sc = $shell.CreateShortcut($lnk)
        if (-not $exists -or $sc.TargetPath -ne $browser -or $sc.Arguments -ne $appArgs -or $sc.IconLocation -ne "$icon,0" -or [ClaudeMonLnkAppId]::Get($lnk) -ne $appId) {
            $sc.TargetPath = $browser
            $sc.Arguments = $appArgs
            $sc.IconLocation = "$icon,0"
            $sc.Description = 'ClaudeMon: điều khiển session Claude Code trên mọi máy'
            $sc.WorkingDirectory = $Root
            $sc.Save()
            [ClaudeMonLnkAppId]::Set($lnk, $appId)
            Say "đã tạo shortcut ClaudeMon ở $($place.Name)"
        }
    }
} else {
    Say 'không thấy Chrome hay Edge, bỏ qua shortcut'
}

# --- 6. Tailscale ---------------------------------------------------------------------------------
$Mode = if ($Config.access -and $Config.access.mode) { [string]$Config.access.mode } else { 'tailscale' }
if ($Mode -ne 'tailscale') { Say "truy cập từ xa: chế độ '$Mode' (machines.json > access), bỏ qua tailscale serve"; exit 0 }
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }
if (-not (Test-Path -LiteralPath $ts)) { Say 'chưa cài Tailscale, máy khác chưa vào được agent này'; exit 0 }

$status = $null
try { $status = & $ts status --json 2>$null | Out-String | ConvertFrom-Json } catch {}
if (-not $status -or $status.BackendState -ne 'Running') { Say 'Tailscale chưa đăng nhập, bỏ qua tailscale serve'; exit 0 }

$tsName = ($status.Self.DNSName -split '\.')[0]
if ($Self -and $Self.host -and $tsName -ne $Self.host) {
    & $ts set --hostname $Self.host | Out-Null
    Say "đã đặt tên máy trong tailnet là $($Self.host)"
}
$serve = (& $ts serve status --json 2>$null | Out-String)
if ($serve -notmatch "127\.0\.0\.1:$Port") {
    & $ts serve --bg $Port | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "tailscale serve --bg $Port lỗi (mã $LASTEXITCODE)" }
    Say "đã mở agent trong tailnet (tailscale serve --bg $Port)"
}
exit 0
