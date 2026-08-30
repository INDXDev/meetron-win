use serde::Serialize;
use std::ffi::c_void;
use std::io::{self, Read};
use std::ptr;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};
use windows_core::HRESULT;

const MAX_SECRET_BYTES: usize = 2_560;
const ERROR_NOT_FOUND: u32 = 1_168;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    ok: bool,
    found: Option<bool>,
    deleted: Option<bool>,
    secret: Option<String>,
}

fn usage() -> ! {
    eprintln!("Usage: meetron-credential <get|set|delete> <Meetron:target>");
    std::process::exit(2);
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn validate_target(value: &str) -> Result<(), String> {
    if !value.starts_with("Meetron:") || value.len() > 256 || value.chars().any(char::is_control) {
        return Err("Credential target must be a valid Meetron: target".to_string());
    }
    Ok(())
}

fn is_not_found(error: &windows_core::Error) -> bool {
    error.code() == HRESULT::from_win32(ERROR_NOT_FOUND)
}

fn read_secret(target: &str) -> Result<Option<String>, String> {
    let target = wide(target);
    let mut raw = ptr::null_mut();
    let result = unsafe { CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0, &mut raw) };
    if let Err(error) = result {
        return if is_not_found(&error) {
            Ok(None)
        } else {
            Err(format!("Credential Manager read failed: {error}"))
        };
    }
    if raw.is_null() {
        return Err("Credential Manager returned an empty credential pointer".to_string());
    }

    let secret = unsafe {
        let credential = &*raw;
        let bytes = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        );
        let decoded = String::from_utf8(bytes.to_vec())
            .map_err(|_| "Stored credential is not valid UTF-8".to_string());
        CredFree(raw.cast::<c_void>());
        decoded?
    };
    Ok(Some(secret))
}

fn write_secret(target: &str, secret: &str) -> Result<(), String> {
    let mut target = wide(target);
    let mut username = wide("Meetron");
    let mut blob = secret.as_bytes().to_vec();
    if blob.len() > MAX_SECRET_BYTES {
        return Err(format!("Credential exceeds {MAX_SECRET_BYTES} bytes"));
    }
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: PWSTR(username.as_mut_ptr()),
        ..Default::default()
    };
    unsafe { CredWriteW(&credential, 0) }
        .map_err(|error| format!("Credential Manager write failed: {error}"))
}

fn delete_secret(target: &str) -> Result<bool, String> {
    let target = wide(target);
    match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, 0) } {
        Ok(()) => Ok(true),
        Err(error) if is_not_found(&error) => Ok(false),
        Err(error) => Err(format!("Credential Manager delete failed: {error}")),
    }
}

fn print_response(response: Response) -> Result<(), String> {
    println!(
        "{}",
        serde_json::to_string(&response).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| usage());
    let target = args.next().unwrap_or_else(|| usage());
    if args.next().is_some() {
        usage();
    }
    validate_target(&target)?;

    match command.as_str() {
        "get" => {
            let secret = read_secret(&target)?;
            print_response(Response {
                ok: true,
                found: Some(secret.is_some()),
                deleted: None,
                secret,
            })
        }
        "set" => {
            let mut secret = Vec::new();
            io::stdin()
                .take((MAX_SECRET_BYTES + 1) as u64)
                .read_to_end(&mut secret)
                .map_err(|error| format!("Could not read credential from stdin: {error}"))?;
            if secret.len() > MAX_SECRET_BYTES {
                return Err(format!("Credential exceeds {MAX_SECRET_BYTES} bytes"));
            }
            let secret = String::from_utf8(secret)
                .map_err(|_| "Credential input must be valid UTF-8".to_string())?;
            write_secret(&target, &secret)?;
            print_response(Response {
                ok: true,
                found: None,
                deleted: None,
                secret: None,
            })
        }
        "delete" => print_response(Response {
            ok: true,
            found: None,
            deleted: Some(delete_secret(&target)?),
            secret: None,
        }),
        _ => usage(),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
