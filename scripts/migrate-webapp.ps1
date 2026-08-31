<#
.SYNOPSIS
  Stands up (or updates) an Azure Web App to run the platform-api container
  image, wired the same way as platform-api-bian-keyVault: container image +
  registry credentials, app settings copied from a source app (excluding
  DATABASE_URL), WEBSITES_PORT, and a managed identity for Key Vault access.

.EXAMPLE
  ./scripts/migrate-webapp.ps1 -WebAppName platform-api-bian-dr -ResourceGroup Common_Services

.NOTES
  Requires `az login` first. Prompts interactively for the Docker Hub
  registry password so it never appears in shell history or process args.
#>
param(
    [Parameter(Mandatory = $true)][string]$WebAppName,
    [string]$ResourceGroup = "Common_Services",
    [string]$Plan = "platform-api-bian-plan",
    [string]$Image = "arnabmitrabian/platform-api-prod:latest",
    [string]$RegistryUser = "arnabmitrabian",
    [string]$SourceAppForSettings = "platform-api-bian",
    [string]$KeyVaultName = "BIANSANDBOXKEY"
)

$ErrorActionPreference = "Stop"

Write-Host "Checking whether '$WebAppName' already exists in '$ResourceGroup'..."
$existing = az webapp show --resource-group $ResourceGroup --name $WebAppName --query name -o tsv 2>$null
if ($existing) {
    Write-Host "'$WebAppName' already exists - updating its container/app settings in place."
} else {
    Write-Host "Creating '$WebAppName' on plan '$Plan'..."
    az webapp create --resource-group $ResourceGroup --name $WebAppName --plan $Plan `
        --container-image-name $Image --container-registry-user $RegistryUser
    if ($LASTEXITCODE -ne 0) { throw "az webapp create failed" }
}

$securePassword = Read-Host -Prompt "Docker Hub password for '$RegistryUser'" -AsSecureString
$bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
    $registryPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

Write-Host "Configuring container image and registry credentials..."
az webapp config container set --resource-group $ResourceGroup --name $WebAppName `
    --docker-custom-image-name $Image `
    --docker-registry-server-url "https://index.docker.io" `
    --docker-registry-server-user $RegistryUser `
    --docker-registry-server-password $registryPassword
if ($LASTEXITCODE -ne 0) { throw "az webapp config container set failed" }
Remove-Variable registryPassword

Write-Host "Copying app settings from '$SourceAppForSettings' (excluding DATABASE_URL)..."
$sourceSettings = az webapp config appsettings list --resource-group $ResourceGroup --name $SourceAppForSettings -o json | ConvertFrom-Json
$filtered = $sourceSettings | Where-Object { $_.name -ne "DATABASE_URL" }
$tempFile = [System.IO.Path]::GetTempFileName()
try {
    $filtered | ConvertTo-Json | Set-Content -Path $tempFile -Encoding utf8
    az webapp config appsettings set --resource-group $ResourceGroup --name $WebAppName --settings "@$tempFile"
    if ($LASTEXITCODE -ne 0) { throw "az webapp config appsettings set failed" }
} finally {
    Remove-Item $tempFile -ErrorAction SilentlyContinue
}

if (-not ($filtered.name -contains "WEBSITES_PORT")) {
    Write-Host "Setting WEBSITES_PORT=3004 (required for classic single-container Linux apps; Site Containers auto-detects this instead)..."
    az webapp config appsettings set --resource-group $ResourceGroup --name $WebAppName --settings WEBSITES_PORT=3004 | Out-Null
}

Write-Host "Enabling managed identity for Key Vault access..."
$principalId = az webapp identity assign --resource-group $ResourceGroup --name $WebAppName --query principalId -o tsv
if ($LASTEXITCODE -ne 0) { throw "az webapp identity assign failed" }
Write-Host "Managed identity principalId: $principalId"

$vaultId = az keyvault show --name $KeyVaultName --query id -o tsv
if ($LASTEXITCODE -eq 0 -and $vaultId) {
    Write-Host "Granting 'Key Vault Secrets User' on '$KeyVaultName'..."
    az role assignment create --assignee $principalId --role "Key Vault Secrets User" --scope $vaultId | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Role assignment failed - grant it manually: az role assignment create --assignee $principalId --role 'Key Vault Secrets User' --scope $vaultId"
    }
} else {
    Write-Warning "Could not resolve Key Vault '$KeyVaultName' - grant Key Vault access to principalId '$principalId' manually."
}

Write-Host "Restarting '$WebAppName'..."
az webapp restart --resource-group $ResourceGroup --name $WebAppName
if ($LASTEXITCODE -ne 0) { throw "az webapp restart failed" }

Write-Host ""
Write-Host "Done. https://$WebAppName.azurewebsites.net/"
Write-Host "Key Vault app settings (e.g. POSTGRESQLSANDBOXPLATEFORMAPIURI) take a minute or two to resolve after the role assignment propagates."
