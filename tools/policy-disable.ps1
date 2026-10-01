# 由控制面板以管理员权限调用：清理 RemoteDebuggingAllowed 策略。
# 只删这一个值；如果这个键因此变空（说明是我们建的），再把空键也删掉。
$ErrorActionPreference = 'Stop'

$key = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
if (Test-Path $key) {
    Remove-ItemProperty -Path $key -Name 'RemoteDebuggingAllowed' -ErrorAction SilentlyContinue
    $item = Get-Item -Path $key -ErrorAction SilentlyContinue
    if ($item) {
        $props = @($item.Property)
        if ($props.Count -eq 0) {
            Remove-Item -Path $key -Force -ErrorAction SilentlyContinue
            Write-Output 'key-removed'
            exit 0
        }
    }
}
Write-Output 'RemoteDebuggingAllowed=removed'
