$port = 5000
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")

try {
    $listener.Start()
    Write-Host "=====================================================" -ForegroundColor Cyan
    Write-Host "  VoxScribe Speech-to-Text Server Started!" -ForegroundColor Green
    Write-Host "  URL: http://localhost:$port/" -ForegroundColor Yellow
    Write-Host "  Malayalam • Arabic • English Live Transcription" -ForegroundColor White
    Write-Host "=====================================================" -ForegroundColor Cyan
    Write-Host "Press Ctrl+C to stop the server." -ForegroundColor Gray

    # Open default browser
    Start-Process "http://localhost:$port/"

    while ($listener.IsListening) {
        try {
            $context = $listener.GetContext()
            $request = $context.Request
            $response = $context.Response
            
            $urlPath = $request.Url.LocalPath
            if ($urlPath -eq "/" -or [string]::IsNullOrWhiteSpace($urlPath)) { 
                $urlPath = "/index.html" 
            }
            
            $filePath = Join-Path $PSScriptRoot ($urlPath.TrimStart('/').Replace('/', '\'))
            
            if (Test-Path $filePath -PathType Leaf) {
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $mime = switch ($ext) {
                    ".html" { "text/html; charset=utf-8" }
                    ".css"  { "text/css; charset=utf-8" }
                    ".js"   { "application/javascript; charset=utf-8" }
                    ".json" { "application/json; charset=utf-8" }
                    ".png"  { "image/png" }
                    ".svg"  { "image/svg+xml" }
                    default { "application/octet-stream" }
                }
                $response.ContentType = $mime
                $response.ContentLength64 = $bytes.Length
                $response.StatusCode = 200

                if ($request.HttpMethod -ne "HEAD") {
                    $response.OutputStream.Write($bytes, 0, $bytes.Length)
                }
            } else {
                $response.StatusCode = 404
            }
            $response.Close()
        } catch {
            Write-Warning "Request handling notice: $_"
        }
    }
} catch {
    Write-Error $_
} finally {
    if ($listener -ne $null -and $listener.IsListening) {
        $listener.Stop()
    }
}
