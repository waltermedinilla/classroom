# sync-prod.ps1 — Trae la BD de producción a local (un solo comando)
#
# Uso: .\sync-prod.ps1
# Requiere: SSH con acceso a walter@100.114.77.83 (via Tailscale)

$SSH_HOST = "walter@100.114.77.83"
$SCRIPT    = Join-Path $PSScriptRoot "pull-from-prod.js"

Write-Host "Abriendo tunel SSH..." -ForegroundColor Cyan
$tunnel = Start-Process -FilePath "ssh" `
  -ArgumentList "-L 27018:127.0.0.1:27017 $SSH_HOST -N -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new" `
  -PassThru -WindowStyle Hidden

# Espera a que el túnel esté listo
Start-Sleep -Seconds 3

if ($tunnel.HasExited) {
  Write-Host "ERROR: No se pudo abrir el tunel SSH. Verificá que Tailscale esté conectado." -ForegroundColor Red
  exit 1
}

Write-Host "Tunel activo (PID $($tunnel.Id)). Sincronizando BD..." -ForegroundColor Green
Write-Host ""

try {
  node $SCRIPT
} finally {
  Write-Host ""
  Write-Host "Cerrando tunel SSH..." -ForegroundColor Cyan
  Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
}
