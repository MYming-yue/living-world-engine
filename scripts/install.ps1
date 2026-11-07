param(
    [string]$SillyTavernPath = (Join-Path $PSScriptRoot '..\..\sillytavern'),
    [string]$DataRoot,
    [string]$UserHandle = 'default-user',
    [switch]$EnableServerPlugin
)

$ErrorActionPreference = 'Stop'
$tavernRoot = (Resolve-Path -LiteralPath $SillyTavernPath).Path
$sourceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $tavernRoot 'server.js'))) { throw 'SillyTavern server.js not found.' }
if ($UserHandle -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid user handle.' }
if (-not $DataRoot) { $DataRoot = Join-Path $tavernRoot 'data' }
$dataPath = [System.IO.Path]::GetFullPath($DataRoot, $tavernRoot)
$pluginRoot = Join-Path $tavernRoot 'plugins'
$serverTarget = Join-Path $pluginRoot 'living-world-engine'
$extensionTarget = Join-Path $dataPath "$UserHandle\extensions\living-world-engine"
$configPath = Join-Path $tavernRoot 'config.yaml'

if ($EnableServerPlugin) {
    $configText = [System.IO.File]::ReadAllText($configPath)
    $enabledPattern = '(?m)^enableServerPlugins:[ \t]*true[ \t]*(?:#[^\r\n]*)?\r?$'
    $enabled = [regex]::IsMatch($configText, $enabledPattern)
    if (-not $enabled) {
        $otherPlugins = @(Get-ChildItem -LiteralPath $pluginRoot -Force | Where-Object {
            $_.Name -ne 'living-world-engine' -and ($_.PSIsContainer -or $_.Extension -in '.js','.cjs','.mjs')
        })
        if ($otherPlugins.Count) { throw 'Other server plugins are present. Review them before enabling the server plugin loader.' }
        $updatedConfig = [regex]::Replace($configText, '(?m)^(enableServerPlugins:[ \t]*)false(?=[ \t]*(?:#[^\r\n]*)?\r?$)', '$1true')
        if (-not [regex]::IsMatch($updatedConfig, $enabledPattern)) { throw 'Could not enable server plugins in config.yaml.' }
    }
}

function Install-Part([string]$Name, [string]$Destination, [string[]]$Files) {
    $stamp = Join-Path $Destination '.lwe-installed'
    if ((Test-Path -LiteralPath $Destination) -and -not (Test-Path -LiteralPath $stamp)) {
        throw "Refusing to overwrite an existing unrecognized installation at $Destination"
    }
    New-Item -Path $Destination -ItemType Directory -Force | Out-Null
    foreach ($fileName in $Files) {
        Copy-Item -LiteralPath (Join-Path $sourceRoot "$Name\$fileName") -Destination (Join-Path $Destination $fileName) -Force
    }
    [System.IO.File]::WriteAllText($stamp, 'living-world-engine')
}

Install-Part 'server' $serverTarget @('index.mjs', 'world.mjs', 'history.mjs')
Install-Part 'extension' $extensionTarget @('manifest.json', 'index.js', 'recorder.js', 'style.css')
if ($EnableServerPlugin -and $updatedConfig) {
    [System.IO.File]::WriteAllText($configPath, $updatedConfig, [System.Text.UTF8Encoding]::new($false))
}
Write-Output "Server plugin: $serverTarget"
Write-Output "UI extension:  $extensionTarget"
Write-Output 'Restart SillyTavern to load the server plugin, then open Extensions > Living World Engine.'
