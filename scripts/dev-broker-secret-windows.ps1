$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$AllowedOwners = @($CurrentUser.Value, 'S-1-5-18', 'S-1-5-32-544')

function New-PrivateSecurity([bool] $Directory) {
    if ($Directory) {
        $Security = New-Object System.Security.AccessControl.DirectorySecurity
        $Inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        $Security = New-Object System.Security.AccessControl.FileSecurity
        $Inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $Security.SetAccessRuleProtection($true, $false)
    foreach ($Sid in $AllowedOwners) {
        $Identity = New-Object System.Security.Principal.SecurityIdentifier($Sid)
        $Rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $Identity,
            [System.Security.AccessControl.FileSystemRights]::FullControl,
            $Inheritance,
            [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow
        )
        $Security.AddAccessRule($Rule)
    }
    return $Security
}

function Assert-AllowedOwner($Security) {
    $Owner = $Security.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($AllowedOwners -notcontains $Owner) {
        throw 'Development broker state is owned by another account.'
    }
}

function Assert-PrivateSecurity($Security) {
    if (-not $Security.AreAccessRulesProtected) {
        throw 'Filesystem did not apply the private development broker ACL.'
    }
    $Rules = @($Security.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    foreach ($Rule in $Rules) {
        if ($Rule.IsInherited -or $AllowedOwners -notcontains $Rule.IdentityReference.Value -or
            $Rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            ($Rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
            throw 'Filesystem did not apply the private development broker ACL.'
        }
    }
    foreach ($Sid in $AllowedOwners) {
        if ($Rules.IdentityReference.Value -notcontains $Sid) {
            throw 'Filesystem did not apply the private development broker ACL.'
        }
    }
}

function Ensure-PrivateDirectory([string] $Path, [bool] $Dedicated) {
    $Directory = New-Object System.IO.DirectoryInfo($Path)
    if ($Directory.Exists) {
        if ($Dedicated) {
            Assert-AllowedOwner ($Directory.GetAccessControl())
            $Directory.SetAccessControl((New-PrivateSecurity $true))
            Assert-PrivateSecurity ($Directory.GetAccessControl())
        }
        return
    }
    if ($null -ne $Directory.Parent) {
        Ensure-PrivateDirectory $Directory.Parent.FullName $false
    }
    $Directory.Create((New-PrivateSecurity $true))
    Assert-PrivateSecurity ($Directory.GetAccessControl())
}

$StateDirectory = $env:SEALWIRE_DEV_SECRET_DIRECTORY
Ensure-PrivateDirectory $StateDirectory ([System.IO.Path]::GetFileName($StateDirectory) -eq '.agent-relay')
$Path = [System.IO.Path]::Combine($StateDirectory, $env:SEALWIRE_DEV_SECRET_FILENAME)
$File = New-Object System.IO.FileInfo($Path)
if ($File.Exists) {
    Assert-AllowedOwner ($File.GetAccessControl())
    $File.SetAccessControl((New-PrivateSecurity $false))
    Assert-PrivateSecurity ($File.GetAccessControl())
    [Console]::Write([System.IO.File]::ReadAllText($Path).Trim())
    exit 0
}

$Bytes = New-Object byte[] 48
$Random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $Random.GetBytes($Bytes) } finally { $Random.Dispose() }
$Secret = [Convert]::ToBase64String($Bytes)
$Stream = New-Object System.IO.FileStream(
    $Path,
    [System.IO.FileMode]::CreateNew,
    ([System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::ReadPermissions),
    [System.IO.FileShare]::None,
    4096,
    [System.IO.FileOptions]::None,
    (New-PrivateSecurity $false)
)
try {
    Assert-PrivateSecurity ($Stream.GetAccessControl())
    $Encoded = [System.Text.Encoding]::UTF8.GetBytes($Secret + "`n")
    $Stream.Write($Encoded, 0, $Encoded.Length)
} finally {
    $Stream.Dispose()
}
[Console]::Write($Secret)
