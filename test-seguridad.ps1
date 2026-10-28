<#
.SYNOPSIS
  Smoke test de los fixes de la auditoria de seguridad (Fusion Wok).

.DESCRIPTION
  Corre curls contra la API y reporta PASS/FAIL/SKIP por hallazgo.
  No hace trafico externo (nada de Nominatim/OSRM): los unicos tests
  que van a la API de Mercado Pago son los de webhook, y solo firman
  localmente con MP_WEBHOOK_SECRET.

  Los tests de rate limit agotan buckets por 60 s: espera un minuto
  entre corridas, o vas a ver FAIL por buckets ya consumidos.

.PARAMETER Base
  URL de la API. Default http://localhost:3001 (npm run dev).

.PARAMETER AdminToken
  Token del panel para los tests que necesitan sesion (B-7).
  Tambien se lee de la variable de entorno ADMIN_TOKEN.

.PARAMETER Full
  Ademas agrega npm audit, npm run lint y npm test.

.EXAMPLE
  .\test-seguridad.ps1
  .\test-seguridad.ps1 -Base http://localhost:5173 -AdminToken "eyJ..."
  .\test-seguridad.ps1 -Full
#>
param(
  [string]$Base = "http://localhost:3001",
  [string]$AdminToken = "",
  [switch]$Full
)

$ErrorActionPreference = "SilentlyContinue"
if (-not $AdminToken) { $AdminToken = $env:ADMIN_TOKEN }

$script:pass = 0
$script:fail = 0
$script:skip = 0
$script:bodyFile = Join-Path $env:TEMP "wok-seg-body.txt"

function Http {
  param([string]$Method = "GET", [string]$Path, [string]$Body = $null, [string[]]$Header = @())
  $url = if ($Path -match "^https?://") { $Path } else { "$Base$Path" }
  $argv = @("-s", "-m", "25", "-X", $Method, "-o", $script:bodyFile, "-w", "%{http_code}")
  foreach ($h in $Header) { $argv += @("-H", $h) }
  if ($Body) { $argv += @("-H", "Content-Type: application/json", "--data-raw", $Body) }
  $argv += $url
  $code = (& curl.exe @argv 2>$null | Where-Object { $_ } | Select-Object -Last 1)
  $text = if (Test-Path $script:bodyFile) { [string](Get-Content $script:bodyFile -Raw) } else { "" }
  [pscustomobject]@{ Code = [int]$code; Body = $text }
}

function Check {
  param([string]$Name, [bool]$Ok, [string]$Detail = "")
  if ($Ok) { $script:pass++; Write-Host "  [PASS] $Name" -ForegroundColor Green }
  else {
    $script:fail++
    Write-Host "  [FAIL] $Name" -ForegroundColor Red
    if ($Detail) { Write-Host "         $Detail" -ForegroundColor DarkGray }
  }
}

function Skip {
  param([string]$Name, [string]$Why)
  $script:skip++
  Write-Host "  [SKIP] $Name  ($Why)" -ForegroundColor Yellow
}

function Section { param([string]$Title) Write-Host "`n== $Title ==" -ForegroundColor Cyan }

# HMAC-SHA256 en hex, igual que hace Mercado Pago para firmar el webhook.
function Sign-Hex {
  param([string]$Manifest, [string]$Secret)
  $h = New-Object System.Security.Cryptography.HMACSHA256([Text.Encoding]::UTF8.GetBytes($Secret))
  (($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($Manifest))) | ForEach-Object { $_.ToString("x2") }) -join ""
}

Write-Host "`nFusion Wok - smoke test de seguridad" -ForegroundColor White
Write-Host "API: $Base"
if ($AdminToken) { Write-Host "Admin: token presente" } else { Write-Host "Admin: sin token (los tests de panel se saltean)" }
Write-Host "Aviso: los tests de rate limit consumen buckets por 60 s.`n"

# ---------------------------------------------------------------- preflight
Section "Preflight"
$ping = Http GET "/api/menu/tandil"
Check "la API responde (GET /api/menu/tandil)" ($ping.Code -eq 200) "code=$($ping.Code)"
if ($ping.Code -ne 200) {
  Write-Host "`nNo hay API arriba. Levantala con:  npm run dev" -ForegroundColor Yellow
  exit 2
}

# ------------------------------------------------------------------- M-1
Section "M-1  rate limit by-phone normalizado (3 formatos = 1 bucket)"
# El limite por telefono+IP es 8 en 10 min. Con la clave normalizada a
# digitos, 4 + 4 + 1 en formatos distintos agota el mismo bucket.
$tel = "2264000000"
$fmt = @(
  "2264000000",
  "226 4000-000",
  "+54 226 4000 000"
)
$codes = @()
for ($i = 0; $i -lt 9; $i++) {
  $f = $fmt[$i % $fmt.Count]
  $codes += (Http GET "/api/orders/by-phone/$([uri]::EscapeDataString($f))").Code
}
$limiter = ($codes | Where-Object { $_ -eq 429 }).Count
Check "el 10mo request (3 formatos) devuelve 429" ($codes[-1] -eq 429) "codigos: $($codes -join ',')"
Check "al menos un 429 en la ventana" ($limiter -ge 1) "429=$limiter"

# ------------------------------------------------------------------- M-2
Section "M-2  oraculo de cupones (mensaje uniforme)"
$codes2 = @("ZZZNOEXISTE", "PRUEBAXX", "TESTVENCIDO")
$mensajes = @()
foreach ($c in $codes2) {
  $r = Http POST "/api/coupons/validate" ('{"code":"' + $c + '","total":5000,"branch":"tandil"}')
  $mensajes += $r.Body
}
$iguales = ($mensajes | Where-Object { $_ -match "Cup\u00f3n inv\u00e1lido" }).Count
Check "3 codigos inexistentes -> mismo 'Cupón inválido'" ($iguales -eq 3) ($mensajes -join " | ")
$leak = ($mensajes | Where-Object { $_ -match "no existe|vencido|agotado|inactivo" }).Count
Check "ningun mensaje filtra el estado real del cupon" ($leak -eq 0) ($mensajes -join " | ")

# ------------------------------------------------------------------- M-3
Section "M-3  cola externa de envios (tope MAX_EXTERNAL_QUEUE=20)"
# El flood real se cubre en test/shipping.test.js (red mockeada): aca solo
# se verifica que el endpoint siga respondiendo y no acumule 500.
$q1 = Http POST "/api/shipping/quote" '{"branch":"tandil","address":"San Martin 1000"}'
$q2 = Http POST "/api/shipping/quote" '{"branch":"tandil","address":"Avenida 200"}'
$ok = (($q1.Code -eq 200 -or $q1.Code -eq 503) -and ($q2.Code -eq 200 -or $q2.Code -eq 503))
Check "cotizaciones responden 200/503 (nunca 500)" $ok "q1=$($q1.Code) q2=$($q2.Code)"
Write-Host "         el tope de la cola se verifica con: node --test test/shipping.test.js" -ForegroundColor DarkGray

# ------------------------------------------------------------------- M-4
Section "M-4  rate limit de lectura de pedidos"
$codes3 = @()
for ($i = 0; $i -lt 61; $i++) { $codes3 += (Http GET "/api/orders/99999999").Code }
Check "GET /api/orders/:id corta en 60/min (429 en el 61)" ($codes3[-1] -eq 429) "ultimo=$($codes3[-1])"

$codes4 = @()
for ($i = 0; $i -lt 6; $i++) { $codes4 += (Http GET "/api/orders/number/FW-999999").Code }
Check "GET /api/orders/number corta en 5/min (429 en el 6)" ($codes4[-1] -eq 429) "codigos: $($codes4 -join ',')"

# ------------------------------------------------------------------- B-4
Section "B-4  firma del webhook: query y body tienen que coincidir"
$sinFirma = Http POST "/api/webhooks/mercadopago" '{"type":"order","data":{"id":"ORD1"}}'
Check "sin X-Signature se rechaza" ($sinFirma.Code -eq 400) "code=$($sinFirma.Code)"

if (-not $env:MP_WEBHOOK_SECRET) {
  Skip "B-4 query != body" "MP_WEBHOOK_SECRET no esta en el entorno"
} else {
  # Firma VALIDA sobre el id del query, pero el body trae otro id: antes del
  # fix la firma pasaba y el handler procesaba el id del body.
  $ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  $qid = "ORDQUERY999"
  $bid = "ORDBODY888"
  $manifest = "id:$($qid.ToLower());ts:$ts;"
  $sig = Sign-Hex $manifest $env:MP_WEBHOOK_SECRET
  $hdr = "X-Signature: ts=$ts;v1=$sig"
  $r = Http POST "/api/webhooks/mercadopago?data.id=$qid" ('{"type":"order","data":{"id":"' + $bid + '"}}') @($hdr)
  Check "query != body -> 400 'Firma invalida'" (($r.Code -eq 400) -and ($r.Body -match "Firma inv")) "code=$($r.Code) body=$($r.Body)"
}

# ------------------------------------------------------------------- B-7
Section "B-7  pedido manual con Mercado Pago"
if (-not $AdminToken) {
  Skip "rechaza paymentMethod=mercadopago" "sin -AdminToken"
} else {
  # Body minimo que pasa validateOrderBody: producto real del menu.
  $menu = (Http GET "/api/menu/tandil").Body | ConvertFrom-Json
  $prod = $null
  foreach ($c in $menu.categories) { if (-not $prod) { foreach ($g in $c.groups) { if (-not $prod -and $g.products.Count -gt 0) { $prod = $g.products[0] } } } }
  if (-not $prod) {
    Skip "rechaza paymentMethod=mercadopago" "sin productos en el menu"
  } else {
    $body = @{
      source        = "counter"
      branch        = "tandil"
      orderMode     = "delivery"
      paymentMethod = "mercadopago"
      customer      = @{ name = "Prueba Seguridad"; phone = "2264000000"; email = "prueba@fucionwok.test" }
      items         = @(@{ productId = $prod.id; name = $prod.name; qty = 1 })
      address       = @{ street = "San Martin"; number = "1000"; city = "Tandil" }
    } | ConvertTo-Json -Depth 6
    $r = Http POST "/api/admin/orders/manual" $body @("Authorization: Bearer $AdminToken")
    Check "rechaza paymentMethod=mercadopago" (($r.Code -eq 400) -and ($r.Body -match "Mercado Pago")) "code=$($r.Code) body=$($r.Body)"
  }
}

# ------------------------------------------------------- checks manuales
Section "Requieren flujo completo (no se automatizan con curl)"
Write-Host @"
  B-1  refunds.js: dos aprobaciones concurrentes no deben duplicar
       order_created. Unit: node --test test/refunds.test.js

  B-2  cancelar un pedido APROBADO desde el panel NO libera el cupon.
       1. pedido con cupon pagado (payment_status=approved)
       2. PATCH /api/admin/orders/:id/status  {"status":"cancelled"}
       3. SELECT used_count FROM coupons WHERE code='...'  -> NO baja

  B-5  webhook legacy sin CAS: replay no debe revertir refunded->approved.
       Unit: node --test test/refunds.test.js

  B-6  CATALOG con TTL 30 s: editar un producto en /admin y ver que la
       otra instancia converge en <= 30 s (antes: solo al reiniciar).

  B-8  menuCache no cachea sucursales inexistentes + LIMIT 5000 en
       /api/admin/customers (no crece sin tope).

  M-3  tope de cola externa: node --test test/shipping.test.js
"@

# ------------------------------------------------------------------ Full
if ($Full) {
  Section "Estatica completa (npm)"
  $a = (& npm audit 2>&1 | Out-String)
  Check "npm audit -> 0 vulnerabilities" ($a -match "0 vulnerabilities") (($a -split "`n" | Select-Object -Last 3) -join " / ")
  $l = (& npm run lint 2>&1 | Out-String)
  Check "npm run lint -> 0 errors" ($l -notmatch "\d+ errors") (($l -split "`n" | Select-String "problems") -join "")
  $t = (& npm test 2>&1 | Out-String)
  $failLine = ($t -split "`n" | Select-String "^. fail \d+|^\s*fail\s+\d+" | Select-Object -Last 1)
  Check "npm test -> sin fallos" ($t -notmatch "✖ failing tests") "$failLine"
}

# ---------------------------------------------------------------- resumen
Write-Host "`n----------------------------------------" -ForegroundColor White
Write-Host ("PASS {0}   FAIL {1}   SKIP {2}" -f $script:pass, $script:fail, $script:skip) -ForegroundColor White
Write-Host "Los FAIL de rate limit pueden ser buckets de la corrida anterior (espera 60 s).`n"
if ($script:fail -gt 0) { exit 1 } else { exit 0 }
