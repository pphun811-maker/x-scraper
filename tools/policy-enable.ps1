# 由控制面板以管理员权限调用：启用 Chrome 官方策略 RemoteDebuggingAllowed
# 作用：允许在「默认配置目录」上开启调试端口，从而让脚本直接驱动你自己已登录的 Chrome。
# 只写这一个值，不动其它任何策略。
$ErrorActionPreference = 'Stop'

$key = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
if (-not (Test-Path $key)) {
    New-Item -Path $key -Force | Out-Null
}
New-ItemProperty -Path $key -Name 'RemoteDebuggingAllowed' -PropertyType DWord -Value 1 -Force | Out-Null

$check = (Get-ItemProperty -Path $key -Name 'RemoteDebuggingAllowed' -ErrorAction Stop).RemoteDebuggingAllowed
Write-Output "RemoteDebuggingAllowed=$check"
