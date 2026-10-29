$base = "http://localhost:3001/api/orders/number"

function Probar($num, $tel) {
  $body = @{ phone = $tel } | ConvertTo-Json -Compress
  try {
    $r = Invoke-WebRequest -Uri "$base/$num/details" -Method POST -ContentType "application/json" -Body $body -UseBasicParsing
    "$($r.StatusCode) $($r.Content)"
  } catch {
    $code = [int]$_.Exception.Response.StatusCode
    $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
    "$code $($reader.ReadToEnd())"
  }
}

$distintas = @()
$distintas += 1..14 | ForEach-Object { Probar "FW-99999" "1111111111" }
$distintas += 1..14 | ForEach-Object { Probar "FW-00052" ("11111111" + $_.ToString("00")) }
$distintas += 1..4  | ForEach-Object { Probar "FW-00052" "abc" }
$malas = $distintas | Where-Object { $_ -ne '200 {"address":""}' }
"Respuestas distintas de la genérica: $($malas.Count)"
$malas | Select-Object -Unique