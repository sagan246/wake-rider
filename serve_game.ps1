param(
  [string]$BindAddress = '127.0.0.1',
  [ValidateRange(1, 65535)]
  [int]$Port = 8782
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot)
$rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$listenAddress = if ($BindAddress -eq '0.0.0.0') {
  [Net.IPAddress]::Any
} else {
  [Net.IPAddress]::Parse($BindAddress)
}
$listener = [Net.Sockets.TcpListener]::new($listenAddress, $Port)
$mimeTypes = @{ '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.js'='text/javascript; charset=utf-8' }

function Send-Response {
  param($Stream, [int]$Status, [string]$StatusText, [byte[]]$Body, [string]$ContentType)
  $header = "HTTP/1.1 $Status $StatusText`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store, max-age=0`r`nConnection: close`r`n`r`n"
  $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  $Stream.Write($Body, 0, $Body.Length)
}

try {
  $listener.Start()
  Write-Host "Wake Rider Lab server ready at http://${BindAddress}:${Port}/. Press Ctrl+C to stop."
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      # Browsers may open speculative connections before sending a request.
      # A short timeout prevents one idle preconnect from blocking every asset.
      $client.ReceiveTimeout = 2500
      $client.SendTimeout = 10000
      $stream = $client.GetStream()
      $stream.ReadTimeout = 2500
      $stream.WriteTimeout = 10000
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      while ($reader.ReadLine()) { }
      $parts = $requestLine -split ' '
      if ($parts.Length -lt 2 -or $parts[0] -ne 'GET') {
        Send-Response $stream 405 'Method Not Allowed' ([Text.Encoding]::UTF8.GetBytes('Method not allowed')) 'text/plain'
        continue
      }
      $urlPath = [Uri]::UnescapeDataString(($parts[1] -split '\?')[0]).TrimStart('/')
      if (-not $urlPath) { $urlPath = 'index.html' }
      $filePath = [IO.Path]::GetFullPath((Join-Path $root $urlPath))
      if (-not $filePath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not [IO.File]::Exists($filePath)) {
        Send-Response $stream 404 'Not Found' ([Text.Encoding]::UTF8.GetBytes('Not found')) 'text/plain'
        continue
      }
      $body = [IO.File]::ReadAllBytes($filePath)
      $ext = [IO.Path]::GetExtension($filePath).ToLowerInvariant()
      $contentType = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { 'application/octet-stream' }
      Send-Response $stream 200 'OK' $body $contentType
    }
    catch {
      Write-Warning $_.Exception.Message
    }
    finally { $client.Dispose() }
  }
} finally { $listener.Stop() }
