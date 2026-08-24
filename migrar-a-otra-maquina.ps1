# migrar-a-otra-maquina.ps1 — Empaqueta TODO lo que no se puede regenerar en la máquina nueva.
#
# Uso:  .\migrar-a-otra-maquina.ps1
#       .\migrar-a-otra-maquina.ps1 -Destino "E:\mudanza"     (ej. un pendrive)
#
# QUÉ SE LLEVA (y por qué no alcanza con clonar el repo de GitHub):
#   • .env / .env.test  — los secretos. JWT_SECRET es el que firma las sesiones; no está en
#     el repo y no se puede "adivinar". Sin esto la app arranca pero no autentica a nadie.
#   • El dump de la base local `classroom-escuela` (el espejo de producción, ~15 MB).
#   • Los cambios SIN COMMITEAR del working tree, como parche.
#   • Los scripts sueltos que el .gitignore deja afuera (set-superadmin.js y compañía).
#   • issues.txt — tus pedidos y anotaciones. Está gitignoreado: no viaja con el repo.
#   • La memoria del agente (~350 KB), para no perder el contexto de las sesiones.
#
# QUÉ NO SE LLEVA (a propósito — se regenera en destino):
#   • node_modules/ (76 MB)  → npm install
#   • .git/ (507 MB)         → git clone del repo de GitHub: es la misma historia
#   • archivos/ (8,7 GB) y public/archivos/ (895 MB) → son los adjuntos del espejo. Se
#     reponen restaurando un backup de producción desde /superadmin/backup, o se vive sin
#     ellos en desarrollo (se ven los registros, no los archivos).
#   • backups/ (6,8 GB) y el .tar.gz de la raíz → backups viejos, no hacen falta.
#   • logs/ (26 MB) → historial de logs de esta máquina.
#
# ⚠️ La carpeta que genera CONTIENE SECRETOS EN CLARO. No la subas a ningún lado, no la
#    commitees, y borrala del pendrive cuando termines la mudanza.

param(
  [string]$Destino = "$env:USERPROFILE\Desktop\mudanza-classroom",
  # Suma las transcripciones completas de las sesiones de Claude Code (~116 MB). Sin esto
  # viaja solo la memoria (~350 KB), que es lo que el agente lee al arrancar. Las
  # transcripciones sirven para releer una sesión vieja, no para que el agente funcione.
  [switch]$ConHistorial
)

$ErrorActionPreference = 'Stop'
$Proyecto = $PSScriptRoot

Write-Host ""
Write-Host "Empaquetando para mudanza..." -ForegroundColor Cyan
Write-Host "  Origen:  $Proyecto"
Write-Host "  Destino: $Destino"
Write-Host ""

New-Item -ItemType Directory -Force -Path $Destino | Out-Null

# ── 1. Secretos y archivos sueltos que el .gitignore deja afuera ──────────────
$sueltos = @('.env', '.env.test', 'issues.txt', 'set-superadmin.js', 'migrate-themes.js',
             'make-favicon.js', 'Escuela_4118.xlsx', 'ftp-destino.json', 'maintenance.json')
$dirSueltos = Join-Path $Destino 'archivos-sueltos'
New-Item -ItemType Directory -Force -Path $dirSueltos | Out-Null

foreach ($f in $sueltos) {
  $src = Join-Path $Proyecto $f
  if (Test-Path $src) {
    Copy-Item $src -Destination $dirSueltos -Force
    Write-Host "  [ok] $f" -ForegroundColor Green
  } else {
    Write-Host "  [--] $f (no existe en esta máquina)" -ForegroundColor DarkGray
  }
}

# La allowlist de Claude Code: puede tener credenciales pasadas inline en comandos
# aprobados (ver la nota del .gitignore). Se copia aparte y bien señalizada.
$settingsLocal = Join-Path $Proyecto '.claude\settings.local.json'
if (Test-Path $settingsLocal) {
  Copy-Item $settingsLocal -Destination (Join-Path $dirSueltos 'settings.local.json') -Force
  Write-Host "  [ok] .claude/settings.local.json" -ForegroundColor Green
}

# ── 2. Los cambios sin commitear, como parche ────────────────────────────────
# Es la alternativa a pushear. Pushear a main dispara el webhook POST /deploy y el cambio
# sale EN VIVO en la escuela — que es justo lo que no querés que pase por una mudanza.
Push-Location $Proyecto
# git escribe avisos inocuos por stderr (el clásico "LF will be replaced by CRLF"). Con
# ErrorActionPreference='Stop', PowerShell 5.1 los convierte en NativeCommandError y aborta
# el script a mitad del empaquetado. Se baja a 'Continue' solo para este bloque.
$erroresAntes = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  $sucio = git status --porcelain
  if ($sucio) {
    # --output lo escribe GIT, no PowerShell: Out-File en 5.1 mete BOM y `git apply` en
    # destino rechaza el parche. --binary para que un adjunto binario también viaje.
    git diff HEAD --binary --output="$(Join-Path $Destino 'cambios-sin-commitear.patch')"
    # Los archivos NUEVOS no los toma `git diff HEAD`: van aparte, tal cual.
    $nuevos = git ls-files --others --exclude-standard
    if ($nuevos) {
      $dirNuevos = Join-Path $Destino 'archivos-nuevos'
      foreach ($n in $nuevos) {
        $dst = Join-Path $dirNuevos $n
        New-Item -ItemType Directory -Force -Path (Split-Path $dst -Parent) | Out-Null
        Copy-Item (Join-Path $Proyecto $n) -Destination $dst -Force
      }
      Write-Host "  [ok] $($nuevos.Count) archivo(s) nuevo(s) sin trackear" -ForegroundColor Green
    }
    Write-Host "  [ok] cambios-sin-commitear.patch" -ForegroundColor Green
  } else {
    Write-Host "  [--] no hay cambios sin commitear" -ForegroundColor DarkGray
  }

  # El commit exacto en el que quedó esta máquina, para pararse en el mismo en destino.
  git rev-parse HEAD | Out-File -FilePath (Join-Path $Destino 'commit-de-origen.txt') -Encoding utf8
} finally {
  $ErrorActionPreference = $erroresAntes
  Pop-Location
}

# ── 3. Dump de la base local (el espejo de producción) ───────────────────────
$mongodump = 'C:\Program Files\MongoDB\Tools\100\bin\mongodump.exe'
if (Test-Path $mongodump) {
  $dirDump = Join-Path $Destino 'mongodump'
  & $mongodump --uri="mongodb://localhost:27017/classroom-escuela" --out="$dirDump" --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  [ok] mongodump de classroom-escuela" -ForegroundColor Green
  } else {
    Write-Host "  [!!] mongodump falló (¿el servicio MongoDB está corriendo?)" -ForegroundColor Yellow
  }
} else {
  Write-Host "  [!!] no encontré mongodump.exe en $mongodump" -ForegroundColor Yellow
  Write-Host "       Alternativa en destino: .\sync-prod.ps1 (baja el espejo de producción)" -ForegroundColor Yellow
}

# ── 4. Memoria del agente ────────────────────────────────────────────────────
# ⚠️ El nombre de la carpeta CODIFICA LA RUTA DEL PROYECTO. Si en la máquina nueva el
# proyecto no queda en la misma ruta, hay que renombrarla (ver el README que se genera).
$proyectoClaude = "$env:USERPROFILE\.claude\projects\C--Users-Educacion-OneDrive-Desktop-proyectos-classroom-clone"
$destMemoria    = Join-Path $Destino 'claude-memoria'

if (Test-Path $proyectoClaude) {
  if ($ConHistorial) {
    # Todo: memoria + transcripciones .jsonl de cada sesión.
    Copy-Item $proyectoClaude -Destination $destMemoria -Recurse -Force
    Write-Host "  [ok] memoria del agente + historial de sesiones" -ForegroundColor Green
  } else {
    # Solo memory/: es lo único que el agente lee para tener contexto. El resto de la
    # carpeta son transcripciones (~116 MB) que no cambian cómo trabaja.
    New-Item -ItemType Directory -Force -Path $destMemoria | Out-Null
    Copy-Item (Join-Path $proyectoClaude 'memory') -Destination $destMemoria -Recurse -Force
    Write-Host "  [ok] memoria del agente (sin historial; usá -ConHistorial para sumarlo)" -ForegroundColor Green
  }
}

# ── 5. Resumen ───────────────────────────────────────────────────────────────
$peso = [math]::Round((Get-ChildItem $Destino -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host ""
Write-Host "Listo: $peso MB en $Destino" -ForegroundColor Cyan
Write-Host ""
Write-Host "En la máquina nueva, en este orden:" -ForegroundColor White
Write-Host "  1. git clone https://github.com/waltermedinilla/classroom.git classroom-clone"
Write-Host "  2. copiar archivos-sueltos\* a la raíz del proyecto (.env incluido)"
Write-Host "  3. npm install"
Write-Host "  4. mongorestore --uri=`"mongodb://localhost:27017`" --nsInclude=`"classroom-escuela.*`" mongodump"
Write-Host "  5. git apply cambios-sin-commitear.patch  +  copiar archivos-nuevos\*"
Write-Host "  6. copiar claude-memoria a %USERPROFILE%\.claude\projects\ (¡ojo con el nombre!)"
Write-Host ""
Write-Host "NO pushees para mudarte: el webhook de main despliega en vivo en la escuela." -ForegroundColor Yellow
Write-Host ""
