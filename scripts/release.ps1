# scripts/release.ps1 - One-shot Volo release script.
#
# Usage:
#   pwsh scripts/release.ps1 <version> [options]
#
# Examples:
#   pwsh scripts/release.ps1 0.1.9
#   pwsh scripts/release.ps1 0.1.9 -SkipBuild -NotesFile mynotes.md
#   pwsh scripts/release.ps1 0.1.9 -DryRun
#   pwsh scripts/release.ps1 0.1.9 -MinAppVersion 1.6.0
#
# What it does:
#   1. Reads GH_TOKEN/GH_TOKENS/GITHUB_TOKEN from User scope (no manual paste).
#   2. Bumps manifest.json -> version, keeps/resets minAppVersion.
#   3. Adds the new version entry to versions.json.
#   4. Runs `npm run build` to regenerate main.js (skippable).
#   5. Commits, tags (vX.Y.Z), pushes main + tag.
#   6. Creates a GitHub Release with notes from -NotesFile (or a placeholder).
#   7. Uploads manifest.json, main.js, styles.css as release assets so BRAT works.
#
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidatePattern('^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$')]
    [string]$Version,

    [string]$NotesFile,

    [switch]$SkipBuild,

    [switch]$DryRun,

    [string]$MinAppVersion,

    [string]$Repo = 'lonelysh/volo'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# ---- helpers ---------------------------------------------------------------

function Get-GitHubToken {
    # Prefer env-var tokens so users can override, but fall back to the token
    # already proven to work for `gh release create` (and `git push` via
    # `gh auth setup-git`). Classic PATs (ghp_*) silently rot — fine-grained
    # PATs (github_pat_*) are what `gh auth login` now issues, and they're
    # scoped per repo, so this fallback is the only thing that keeps the
    # release script working once a User-scope env var token expires.
    $candidates = @('GH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKENS')
    foreach ($name in $candidates) {
        $t = [System.Environment]::GetEnvironmentVariable($name, 'User')
        if ($t) { return $t }
    }
    $ghTok = (& gh auth token 2>$null)
    if ($ghTok) { return $ghTok.Trim() }
    throw 'No GitHub token. Set GH_TOKEN at User scope, or run `gh auth login`.'
}

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Retry-Block {
    param(
        [ScriptBlock]$Block,
        [int]$Attempts = 5,
        [int]$InitialBackoff = 5
    )
    $lastErr = $null
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            & $Block
            if ($LASTEXITCODE -eq 0) { return }
            $lastErr = "exit code $LASTEXITCODE"
        } catch {
            $lastErr = $_.Exception.Message
        }
        if ($i -lt $Attempts) {
            $delay = $InitialBackoff * $i
            Write-Warning "attempt $i failed ($lastErr); retrying in ${delay}s"
            Start-Sleep -Seconds $delay
        }
    }
    throw "Operation failed after $Attempts attempts. Last error: $lastErr"
}

# ---- 0. verify state -------------------------------------------------------

$tag = "v$Version"

if (git rev-parse -q --verify "refs/tags/$tag" 2>$null) {
    throw "Tag $tag already exists locally. Bump to a new version or `git tag -d $tag` first."
}

if (-not (Test-Path 'manifest.json') -or -not (Test-Path 'versions.json')) {
    throw 'manifest.json / versions.json missing; run from repo root.'
}

# ---- 1. resolve token and set process env ---------------------------------

$tok = Get-GitHubToken
$env:GH_TOKEN = $tok
$env:GITHUB_TOKEN = $tok
# Seed git credential store so any push authenticates without re-entry.
"protocol=https`nhost=github.com`nusername=x-access-token`npassword=$tok" | git credential approve | Out-Null

# Force UTF-8 in this session so `gh` reads/writes release notes cleanly.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001 | Out-Null

# ---- 2. update manifest.json ----------------------------------------------

$manifestPath = Resolve-Path 'manifest.json'
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$prevVersion = $manifest.version

if (-not $MinAppVersion) {
    $existing = Get-Content -Raw -Path 'versions.json' | ConvertFrom-Json
    $sorted = $existing.PSObject.Properties |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+' } |
        Sort-Object Name
    if ($sorted) {
        # Reuse the most recent known minAppVersion; user can override.
        $MinAppVersion = $sorted[-1].Value
    } else {
        $MinAppVersion = $manifest.minAppVersion
    }
}

$manifest.version = $Version
$manifest.minAppVersion = $MinAppVersion
$newManifestJson = $manifest | ConvertTo-Json -Depth 10
$newManifestJson + "`n" | Out-File -FilePath $manifestPath -Encoding utf8 -NoNewline

# ---- 3. update versions.json ----------------------------------------------

$versions = Get-Content -Raw -Path 'versions.json' | ConvertFrom-Json
if ($versions.PSObject.Properties.Name -contains $Version) {
    Write-Warning "versions.json already has key $Version; skipping add"
} else {
    $versions | Add-Member -NotePropertyName $Version -NotePropertyValue $MinAppVersion -Force
    ($versions | ConvertTo-Json -Depth 5) + "`n" | Out-File -FilePath 'versions.json' -Encoding utf8 -NoNewline
}

Write-Step "manifest.json -> version=$Version, minAppVersion=$MinAppVersion (was $prevVersion)"
Write-Step "versions.json -> added $Version : $MinAppVersion"

# ---- 3b. update package.json (if present) ---------------------------------

if (Test-Path 'package.json') {
    $pkgPath = Resolve-Path 'package.json'
    $pkg = Get-Content -Raw -Path $pkgPath | ConvertFrom-Json
    $prevPkgVersion = $pkg.version
    if ($prevPkgVersion -ne $Version) {
        $pkg.version = $Version
        ($pkg | ConvertTo-Json -Depth 5) + "`n" | Out-File -FilePath $pkgPath -Encoding utf8 -NoNewline
        Write-Step "package.json -> version=$Version (was $prevPkgVersion)"
    } else {
        Write-Step "package.json -> version=$Version (no change)"
    }
}

# ---- 4. build (optional) --------------------------------------------------

if ($SkipBuild) {
    Write-Step "Skipping build (existing main.js will be used)"
} else {
    Write-Step "npm run build"
    if (-not $DryRun) {
        Retry-Block -Block { npm run build } -Attempts 3 -InitialBackoff 3
    }
}

# ---- 5. resolve release notes ---------------------------------------------

if (-not $NotesFile -or -not (Test-Path $NotesFile)) {
    $NotesFile = "$env:TEMP\\volo-release-$Version.md"
    @"
## v$Version

### Changes
- TBD
"@ | Out-File -FilePath $NotesFile -Encoding utf8 -NoNewline
    Write-Step "Placeholder notes written to $NotesFile (edit before continuing if you want real notes)"
}

# ---- 6. commit and tag -----------------------------------------------------

git add manifest.json versions.json package.json
if (-not $SkipBuild) { git add main.js }
# styles.css is part of the plugin runtime — must be tracked in the release
# commit too, otherwise the tagged commit points at the previous styles.css
# while the release asset points at the working tree version. Split-brain.
if (Test-Path 'styles.css') { git add styles.css }
# src/ changes are what actually made main.js different from the previous
# tag. Without staging them, the release commit only carries the rebuilt
# bundle — anyone cloning the repo at this tag gets the old source. Stage
# every modified tracked file under src/ so the tagged commit is a faithful
# snapshot of the source the bundle was built from.
$srcFiles = git diff --name-only -- src/
if ($srcFiles) { git add -- $srcFiles }
$staged = @(git diff --cached --name-only)
if ($staged.Count -eq 0) {
    throw 'No staged changes. Aborting.'
}

$commitMsg = "v${Version}: release"
Write-Step "Staged files:"
$staged | ForEach-Object { Write-Host "    $_" }
Write-Step "Commit message: $commitMsg"

if ($DryRun) {
    Write-Step "Dry run complete. Nothing committed or pushed."
    # Restore working tree and unstage so future runs start clean.
    $restore = @('manifest.json', 'versions.json')
    if (Test-Path 'package.json') { $restore += 'package.json' }
    if (Test-Path 'styles.css') { $restore += 'styles.css' }
    git reset HEAD -- $restore | Out-Null
    git checkout -- $restore
    if (-not $SkipBuild -and (Test-Path 'main.js')) {
        git reset HEAD -- main.js | Out-Null
        git checkout -- main.js
    }
    # Restore any src/ files we staged
    $srcFiles = git diff --name-only -- src/
    if ($srcFiles) { git checkout -- $srcFiles }
    return
}

git commit -m $commitMsg | Out-Null
git tag $tag HEAD -m "Volo $tag" | Out-Null

$newSha = git rev-parse HEAD
Write-Step "Created commit $newSha and tag $tag"

# ---- 7. push with retry ---------------------------------------------------

Write-Step "git push origin main"
Retry-Block -Block { git push origin main } -Attempts 6 -InitialBackoff 6

Write-Step "git push origin $tag"
Retry-Block -Block { git push origin $tag } -Attempts 6 -InitialBackoff 6

# ---- 8. create release + upload assets ------------------------------------

Write-Step "gh release create $tag"
Retry-Block -Block {
    gh release create $tag `
        --repo $Repo `
        --title "Volo $tag" `
        --notes-file $NotesFile
} -Attempts 4 -InitialBackoff 5

Write-Step "gh release upload $tag (manifest.json, main.js, styles.css, versions.json)"
Retry-Block -Block {
    gh release upload $tag manifest.json main.js styles.css versions.json --repo $Repo
} -Attempts 4 -InitialBackoff 5

# ---- 9. verify and report -------------------------------------------------

Start-Sleep -Seconds 2
$verify = Invoke-WebRequest -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag" `
    -Headers @{ 'Accept' = 'application/vnd.github+json' }
$rel = ([System.Text.Encoding]::UTF8.GetString(
    [System.Text.Encoding]::UTF8.GetBytes($verify.Content))) | ConvertFrom-Json

if ($rel.tag_name -ne $tag) {
    throw "Release verification failed: got tag $($rel.tag_name)"
}

Write-Step "Done"
Write-Host "tag       : $tag"
Write-Host "url       : $($rel.html_url)"
Write-Host "assets    : $($rel.assets.Count)"
$rel.assets | ForEach-Object { Write-Host "  - $($_.name)  ($($_.size) bytes)" }
