$main = Join-Path $PSScriptRoot '..\dist\src\cli\main.js'
if (-not (Test-Path -LiteralPath $main)) {
    [Console]::Error.WriteLine("vconv is not built: run ``npm install && npm run build`` in $(Split-Path -Parent $PSScriptRoot)")
    exit 2
}
& node $main @args
exit $LASTEXITCODE
