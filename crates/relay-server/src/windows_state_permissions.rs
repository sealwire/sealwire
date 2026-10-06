use std::{
    ffi::c_void,
    fs::File,
    io,
    os::windows::{ffi::OsStrExt, io::FromRawHandle},
    path::Path,
    ptr::{null, null_mut},
};

use windows_sys::Win32::{
    Foundation::{LocalFree, INVALID_HANDLE_VALUE},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT,
        },
        GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetTokenInformation,
        TokenUser, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED, TOKEN_QUERY,
        TOKEN_USER,
    },
    Storage::FileSystem::{
        CreateDirectoryW, CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING, READ_CONTROL, WRITE_DAC,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

struct LocalAllocation(*mut c_void);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}

fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::path::{Component, Prefix};

    let path = std::path::absolute(path)?;
    let wide: Vec<_> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path contains NUL",
        ));
    }
    let prefix = match path.components().next() {
        Some(Component::Prefix(prefix)) => prefix.kind(),
        _ => return Err(io::Error::other("state path has no Windows prefix")),
    };
    let extended = match prefix {
        Prefix::Disk(_) => r"\\?\".encode_utf16().chain(wide).collect::<Vec<_>>(),
        Prefix::UNC(_, _) => r"\\?\UNC\"
            .encode_utf16()
            .chain(wide.into_iter().skip(2))
            .collect(),
        _ => wide,
    };
    Ok(extended.into_iter().chain([0]).collect())
}

fn sid_string(sid: *mut c_void) -> io::Result<String> {
    let mut text = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let allocation = LocalAllocation(text.cast());
    let mut length = 0;
    while unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, length) });
    drop(allocation);
    Ok(value)
}

fn current_user_sid() -> io::Result<String> {
    use std::os::windows::io::{AsRawHandle, OwnedHandle};

    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let mut length = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut length) };
    if length == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_usize; (length as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token.as_raw_handle(),
            TokenUser,
            buffer.as_mut_ptr().cast(),
            length,
            &mut length,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
    sid_string(user.User.Sid)
}

fn descriptor(user_sid: &str, directory: bool) -> io::Result<LocalAllocation> {
    let inheritance = if directory { "OICI" } else { "" };
    // Protect the DACL so permissive parent grants cannot be inherited.
    let sddl = format!(
        "D:P(A;{inheritance};FA;;;{user_sid})(A;{inheritance};FA;;;SY)(A;{inheritance};FA;;;BA)"
    );
    let sddl: Vec<_> = sddl.encode_utf16().chain([0]).collect();
    let mut sd = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut sd,
            null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(LocalAllocation(sd))
}

fn attributes(sd: &LocalAllocation) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: 0,
    }
}

pub(crate) fn create_new_file(path: &Path) -> io::Result<File> {
    let user = current_user_sid()?;
    let sd = descriptor(&user, false)?;
    let attributes = attributes(&sd);
    let path = wide_path(path)?;
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            FILE_GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            &attributes,
            CREATE_NEW,
            FILE_ATTRIBUTE_NORMAL,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    verify_protected_acl(&file)?;
    Ok(file)
}

fn verify_protected_acl(file: &File) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;

    let mut dacl = null_mut();
    let mut sd = null_mut();
    let error = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut sd,
        )
    };
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    let sd = LocalAllocation(sd);
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if dacl.is_null() || control & SE_DACL_PROTECTED == 0 {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "filesystem did not apply the private state ACL",
        ));
    }
    Ok(())
}

pub(crate) fn ensure_directory(path: &Path, dedicated: bool) -> io::Result<()> {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => {
            return if dedicated {
                restrict_existing(path, true)
            } else {
                Ok(())
            };
        }
        Ok(_) => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "state directory is a file",
            ))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        ensure_directory(parent, false)?;
    }
    let user = current_user_sid()?;
    let sd = descriptor(&user, true)?;
    let attributes = attributes(&sd);
    let wide = wide_path(path)?;
    if unsafe { CreateDirectoryW(wide.as_ptr(), &attributes) } == 0 {
        return Err(io::Error::last_os_error());
    }
    restrict_existing(path, true)
}

pub(crate) fn restrict_existing(path: &Path, directory: bool) -> io::Result<()> {
    let user = current_user_sid()?;
    let wide = wide_path(path)?;
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            READ_CONTROL | WRITE_DAC,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let file = unsafe { File::from_raw_handle(handle) };
    restrict_file(&file, &user, directory)
}

fn restrict_file(file: &File, user: &str, directory: bool) -> io::Result<()> {
    use std::os::windows::io::AsRawHandle;

    let mut owner = null_mut();
    let mut actual_dacl = null_mut();
    let mut previous = null_mut();
    let error = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut actual_dacl,
            null_mut(),
            &mut previous,
        )
    };
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    let previous = LocalAllocation(previous);
    let owner = sid_string(owner)?;
    if ![user, "S-1-5-18", "S-1-5-32-544"].contains(&owner.as_str()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "state is owned by another account",
        ));
    }
    let sd = descriptor(user, directory)?;
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    if unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut dacl, &mut defaulted) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if present == 0 || dacl.is_null() {
        return Err(io::Error::other("private state DACL is missing"));
    }
    // Setting a directory DACL propagates inheritable ACEs to its children.
    // Avoid that work when the owner and protected DACL are already correct.
    if private_acl_matches(&previous, actual_dacl, dacl)? {
        return Ok(());
    }
    let error = unsafe {
        SetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            dacl,
            null(),
        )
    };
    if error != 0 {
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    verify_protected_acl(file)
}

fn private_acl_matches(
    sd: &LocalAllocation,
    actual: *mut ACL,
    expected: *mut ACL,
) -> io::Result<bool> {
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut revision) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if actual.is_null() || control & SE_DACL_PROTECTED == 0 {
        return Ok(false);
    }
    let count = unsafe { (*actual).AceCount };
    if count != unsafe { (*expected).AceCount } {
        return Ok(false);
    }
    // Compare ACEs, not ACL allocation sizes: unused ACL space is irrelevant.
    for index in 0..u32::from(count) {
        let mut actual_ace = null_mut();
        let mut expected_ace = null_mut();
        if unsafe { GetAce(actual, index, &mut actual_ace) } == 0
            || unsafe { GetAce(expected, index, &mut expected_ace) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let actual_size = unsafe { (*actual_ace.cast::<ACE_HEADER>()).AceSize };
        let expected_size = unsafe { (*expected_ace.cast::<ACE_HEADER>()).AceSize };
        if actual_size != expected_size {
            return Ok(false);
        }
        let actual_bytes = unsafe {
            std::slice::from_raw_parts(actual_ace.cast::<u8>(), usize::from(actual_size))
        };
        let expected_bytes = unsafe {
            std::slice::from_raw_parts(expected_ace.cast::<u8>(), usize::from(expected_size))
        };
        if actual_bytes != expected_bytes {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
pub(crate) fn acl_snapshot(path: &Path) -> (bool, Vec<(String, u32, u8)>) {
    use windows_sys::Win32::Security::{
        AclSizeInformation, Authorization::GetNamedSecurityInfoW, GetAce, GetAclInformation,
        GetSecurityDescriptorControl, ACCESS_ALLOWED_ACE, ACL_SIZE_INFORMATION, SE_DACL_PROTECTED,
    };

    let wide = wide_path(path).unwrap();
    let mut dacl = null_mut();
    let mut sd = null_mut();
    assert_eq!(
        unsafe {
            GetNamedSecurityInfoW(
                wide.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                &mut dacl,
                null_mut(),
                &mut sd,
            )
        },
        0
    );
    let sd = LocalAllocation(sd);
    assert!(!dacl.is_null());
    let mut control = 0;
    let mut revision = 0;
    assert_ne!(
        unsafe { GetSecurityDescriptorControl(sd.0, &mut control, &mut revision) },
        0
    );
    let mut size = ACL_SIZE_INFORMATION::default();
    assert_ne!(
        unsafe {
            GetAclInformation(
                dacl,
                (&mut size as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        },
        0
    );
    let mut entries = Vec::new();
    for index in 0..size.AceCount {
        let mut entry = null_mut();
        assert_ne!(unsafe { GetAce(dacl, index, &mut entry) }, 0);
        let entry = unsafe { &*entry.cast::<ACCESS_ALLOWED_ACE>() };
        assert_eq!(
            entry.Header.AceType, 0,
            "only access-allowed ACEs are expected"
        );
        let sid = std::ptr::addr_of!(entry.SidStart).cast_mut().cast();
        entries.push((sid_string(sid).unwrap(), entry.Mask, entry.Header.AceFlags));
    }
    entries.sort();
    (control & SE_DACL_PROTECTED != 0, entries)
}

#[cfg(test)]
pub(crate) fn assert_private_acl(path: &Path) {
    use windows_sys::Win32::Security::INHERITED_ACE;
    use windows_sys::Win32::Storage::FileSystem::FILE_ALL_ACCESS;

    let (protected, entries) = acl_snapshot(path);
    assert!(protected, "state must not inherit permissive parent grants");
    let mut expected = vec![
        current_user_sid().unwrap(),
        "S-1-5-18".into(),
        "S-1-5-32-544".into(),
    ];
    expected.sort();
    expected.dedup();
    let mut actual: Vec<_> = entries.iter().map(|entry| entry.0.clone()).collect();
    actual.dedup();
    assert_eq!(
        actual, expected,
        "only the account, SYSTEM and administrators may have access"
    );
    for (_, mask, flags) in entries {
        assert_eq!(mask & FILE_ALL_ACCESS, FILE_ALL_ACCESS);
        assert_eq!(
            u32::from(flags) & INHERITED_ACE,
            0,
            "there must be no inherited ACEs"
        );
    }
}

#[cfg(test)]
pub(crate) fn make_world_readable(path: &Path) {
    use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;

    let sddl: Vec<_> = "D:P(A;OICI;FA;;;WD)".encode_utf16().chain([0]).collect();
    let mut sd = null_mut();
    assert_ne!(
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut sd,
                null_mut(),
            )
        },
        0
    );
    let sd = LocalAllocation(sd);
    let mut present = 0;
    let mut defaulted = 0;
    let mut dacl = null_mut();
    assert_ne!(
        unsafe { GetSecurityDescriptorDacl(sd.0, &mut present, &mut dacl, &mut defaulted) },
        0
    );
    assert_eq!(
        unsafe {
            SetNamedSecurityInfoW(
                wide_path(path).unwrap().as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                dacl,
                null(),
            )
        },
        0
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn matching_permissions_need_no_write_access_and_later_changes_are_repaired() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Foundation::ERROR_ACCESS_DENIED;

        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join(crate::state_paths::STATE_DIR_NAME);
        ensure_directory(&directory, true).unwrap();
        let path = directory.join("session.json");
        drop(create_new_file(&path).unwrap());
        let user = current_user_sid().unwrap();

        for (path, is_directory) in [(&directory, true), (&path, false)] {
            let read_only = std::fs::OpenOptions::new()
                .read(true)
                .access_mode(READ_CONTROL)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .unwrap();
            restrict_file(&read_only, &user, is_directory).unwrap();
            make_world_readable(path);
            assert_eq!(
                restrict_file(&read_only, &user, is_directory)
                    .unwrap_err()
                    .raw_os_error(),
                Some(ERROR_ACCESS_DENIED as i32)
            );
            restrict_existing(path, is_directory).unwrap();
            assert_private_acl(path);
            restrict_file(&read_only, &user, is_directory).unwrap();
        }
    }

    #[test]
    fn a_new_file_is_private_before_any_sensitive_bytes_are_written() {
        let root = tempfile::tempdir().unwrap();
        make_world_readable(root.path());
        let before = acl_snapshot(root.path());
        let path = root.path().join("temporary.json");
        let mut file = create_new_file(&path).unwrap();
        assert_private_acl(&path);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        file.write_all(b"private state").unwrap();
        drop(file);
        let final_path = root.path().join("session.json");
        std::fs::rename(&path, &final_path).unwrap();
        assert_private_acl(&final_path);
        assert_eq!(std::fs::read(&final_path).unwrap(), b"private state");
        assert_eq!(acl_snapshot(root.path()), before);
        assert_eq!(
            create_new_file(&final_path).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
    }

    #[test]
    fn new_directories_are_private_and_existing_shared_directories_are_unchanged() {
        let root = tempfile::tempdir().unwrap();
        make_world_readable(root.path());
        let before = acl_snapshot(root.path());
        ensure_directory(root.path(), false).unwrap();
        let path = root
            .path()
            .join("nested")
            .join(crate::state_paths::STATE_DIR_NAME);
        ensure_directory(&path, true).unwrap();
        assert_private_acl(path.parent().unwrap());
        assert_private_acl(&path);
        make_world_readable(&path);
        ensure_directory(&path, true).unwrap();
        assert_private_acl(&path);
        assert_eq!(acl_snapshot(root.path()), before);
    }

    #[test]
    fn private_state_can_be_created_beyond_the_legacy_windows_path_limit() {
        let root = tempfile::tempdir().unwrap();
        let directory = root
            .path()
            .join("long-path-segment".repeat(8))
            .join("long-path-segment".repeat(8));
        let path = directory.join("session.json");
        assert!(path.as_os_str().encode_wide().count() > 260);
        ensure_directory(&directory, true).unwrap();
        drop(create_new_file(&path).unwrap());
        assert_private_acl(&directory);
        assert_private_acl(&path);
    }
}
