# Build and optionally publish every supported MineLatino Cosmetics artifact.
# mods.json is changed only after GitHub confirms that the release exists.
param(
    [string]$Version = '0.1.0-alpha.48',
    [string[]]$MinecraftVersions = @('1.21.4', '1.21.11', '26.2'),
    [switch]$SkipBuild,
    [switch]$SkipGithub,
    [string]$LocalInstanceMods = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = $PSScriptRoot
$repo = 'GatinoMC/MineLatino-Cosmetics'
$tag = "v$Version"
$javaHome21 = 'C:\Users\fredy\AppData\Roaming\.minecraft\runtime\java-runtime-delta\windows\java-runtime-delta'
$javaHome25 = if ($env:MINELATINO_JAVA25_HOME) { $env:MINELATINO_JAVA25_HOME } else { 'C:\Program Files\Java\jdk-25.0.3' }
$externalBuildRoot = $env:MINELATINO_BUILD_ROOT

$artifacts = @()
foreach ($mcVersion in $MinecraftVersions) {
    $javaHome = if ($mcVersion -eq '26.2') { $javaHome25 } else { $javaHome21 }
    if (-not (Test-Path -LiteralPath (Join-Path $javaHome 'bin\java.exe'))) {
        throw "Java required for Minecraft $mcVersion was not found at $javaHome"
    }
    $env:JAVA_HOME = $javaHome
    $env:Path = "$(Join-Path $javaHome 'bin');$env:Path"
    if ($mcVersion -eq '26.2') { $env:ORG_GRADLE_PROJECT_mcVersion = $mcVersion }
    else { Remove-Item Env:ORG_GRADLE_PROJECT_mcVersion -ErrorAction SilentlyContinue }
    if (-not $SkipBuild) {
        Write-Host "Building Fabric $mcVersion" -ForegroundColor Cyan
        $fabricGradle = Join-Path $repoRoot 'forge\gradlew.bat'
        & $fabricGradle '-p' $repoRoot ':fabric:build' "-PmcVersion=$mcVersion" '--no-daemon'
        if ($LASTEXITCODE -ne 0) { throw "Fabric $mcVersion build failed" }

        Write-Host "Building Forge $mcVersion" -ForegroundColor Cyan
        & (Join-Path $repoRoot 'forge\gradlew.bat') '-p' (Join-Path $repoRoot 'forge') 'build' "-PmcVersion=$mcVersion" '--no-daemon'
        if ($LASTEXITCODE -ne 0) { throw "Forge $mcVersion build failed" }
    }

    foreach ($loader in @('fabric', 'forge')) {
        $jarName = "minelatino-cosmetics-$loader-$mcVersion-$Version.jar"
        $jarPath = if ($loader -eq 'fabric') {
            if ($externalBuildRoot) {
                Join-Path $externalBuildRoot "$mcVersion\fabric\libs\$jarName"
            } else {
                Join-Path $repoRoot "build\$mcVersion\fabric\libs\$jarName"
            }
        } else {
            if ($externalBuildRoot) {
                Join-Path $externalBuildRoot "$mcVersion\forge\libs\$jarName"
            } else {
                Join-Path $repoRoot "forge\build\$mcVersion\libs\$jarName"
            }
        }
        if (-not (Test-Path -LiteralPath $jarPath -PathType Leaf)) { throw "Artifact not found: $jarPath" }
        $file = Get-Item -LiteralPath $jarPath
        $artifacts += [pscustomobject]@{
            MinecraftVersion = $mcVersion
            Loader = $loader
            File = $file
            Sha1 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA1).Hash.ToLowerInvariant()
        }
        Write-Host "$loader ${mcVersion}: $($file.Name) ($($file.Length) bytes)" -ForegroundColor Green
    }
}

if (-not $SkipGithub) {
    gh release view $tag --repo $repo *> $null
    if ($LASTEXITCODE -eq 0) {
        throw "Release $tag already exists. Refusing to replace an immutable published version."
    }

    $releaseArgs = @('release', 'create', $tag, '--repo', $repo, '--title', "MineLatino Cosmetics $tag")
    $notesFile = Join-Path $repoRoot "docs\release-$($Version -replace '^0\.1\.0-', '').md"
    if (Test-Path -LiteralPath $notesFile) {
        $releaseArgs += @('--notes-file', $notesFile)
    } else {
        $releaseArgs += @('--notes', "Cosmetics mod $Version for Minecraft $($MinecraftVersions -join ', ')")
    }
    $releaseArgs += $artifacts.File.FullName
    gh @releaseArgs
    if ($LASTEXITCODE -ne 0) { throw 'GitHub release failed; mods.json was not changed' }

    $versions = foreach ($artifact in $artifacts) {
        @{
            modVersion = $Version
            minecraftVersions = @($artifact.MinecraftVersion)
            loader = $artifact.Loader
            downloadUrl = "https://github.com/$repo/releases/download/$tag/$($artifact.File.Name)"
            sha1 = $artifact.Sha1
            fileName = $artifact.File.Name
            fileSize = $artifact.File.Length
        }
    }
    $manifest = @(@{ id = 'minelatino-cosmetics'; name = 'MineLatino Cosmetics'; versions = @($versions) })
    # -InputObject preserves the outer array even when it contains only one mod.
    # Piping a one-item PowerShell array unwraps it into an object, which makes
    # the launcher backend reject the otherwise valid manifest.
    ConvertTo-Json -InputObject $manifest -Depth 6 | Set-Content -LiteralPath (Join-Path $repoRoot 'mods.json') -Encoding utf8
    Write-Host 'Release published and mods.json generated. Commit it only after reviewing the release.' -ForegroundColor Green
}

if ($LocalInstanceMods) {
    $modsDir = (Resolve-Path -LiteralPath $LocalInstanceMods).Path
    $candidate = $artifacts | Where-Object { $_.Loader -eq 'fabric' } | Select-Object -First 1
    if (-not $candidate) { throw 'No Fabric artifact is available for local installation' }

    # Copy and verify first; old versions remain usable until the replacement is complete.
    $pending = Join-Path $modsDir ($candidate.File.Name + '.pending')
    Copy-Item -LiteralPath $candidate.File.FullName -Destination $pending -Force
    $pendingSha1 = (Get-FileHash -LiteralPath $pending -Algorithm SHA1).Hash.ToLowerInvariant()
    if ($pendingSha1 -ne $candidate.Sha1) { throw 'Local pending JAR failed SHA-1 verification; old mods were preserved' }
    $destination = Join-Path $modsDir $candidate.File.Name
    Move-Item -LiteralPath $pending -Destination $destination -Force
    Get-ChildItem -LiteralPath $modsDir -File -Filter 'minelatino-cosmetics-*.jar' |
        Where-Object { $_.FullName -ne $destination } |
        Remove-Item -Force
    Write-Host "Installed $($candidate.File.Name); older JARs were removed afterwards." -ForegroundColor Green
}
