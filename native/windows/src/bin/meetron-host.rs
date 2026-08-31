// The shim must stay windowless in production, but the test harness needs a
// console to report results on, so the subsystem is only pinned for non-test
// builds.
#![cfg_attr(not(test), windows_subsystem = "windows")]

use std::env;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Component, Path, PathBuf, Prefix};
use std::process::{Command, ExitCode, Stdio};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Threading::{GetCurrentProcess, CREATE_NO_WINDOW};

struct Job(HANDLE);

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn create_kill_on_close_job() -> windows::core::Result<Job> {
    unsafe {
        let job = CreateJobObjectW(None, None)?;
        let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &information as *const _ as *const _,
            std::mem::size_of_val(&information) as u32,
        )?;
        AssignProcessToJobObject(job, GetCurrentProcess())?;
        Ok(Job(job))
    }
}

fn config_path() -> io::Result<PathBuf> {
    let executable = env::current_exe()?;
    Ok(executable.with_file_name("meetron-host.conf"))
}

fn read_config(path: &Path) -> io::Result<(PathBuf, PathBuf)> {
    let contents = fs::read_to_string(path)?;
    let mut lines = contents.lines();
    let node = PathBuf::from(lines.next().unwrap_or_default());
    let script = PathBuf::from(lines.next().unwrap_or_default());
    if !script.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "meetron-host.conf requires an absolute native-host script path",
        ));
    }
    if !script.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "configured native-host script was not found",
        ));
    }
    Ok((node, script))
}

fn environment(name: &str) -> Option<OsString> {
    env::var_os(name)
}

fn windows_directory(lookup: &dyn Fn(&str) -> Option<OsString>) -> PathBuf {
    for variable in ["SystemRoot", "windir"] {
        if let Some(value) = lookup(variable) {
            if !value.is_empty() {
                return PathBuf::from(value);
            }
        }
    }
    PathBuf::from("C:\\Windows")
}

// CreateProcessW resolves a bare program name through the process search path,
// which includes user-writable directories, so every system tool this shim
// spawns is addressed absolutely under %SystemRoot%\System32. This mirrors
// systemExecutable() in src/platform/windows/windows-platform-adapter.mjs.
fn system_executable(name: &str, lookup: &dyn Fn(&str) -> Option<OsString>) -> PathBuf {
    windows_directory(lookup).join("System32").join(name)
}

/// Lower-cases and lexically resolves a path so two spellings of the same
/// location compare equal: `.` and `..` segments are folded away, `/` and `\`
/// are equivalent, and `\\?\C:\` collapses to `c:\`.
fn normalize_path(path: &Path) -> String {
    let mut prefix = String::new();
    let mut rooted = false;
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(value) => {
                prefix = match value.kind() {
                    Prefix::VerbatimDisk(letter) => format!("{}:", letter as char),
                    Prefix::VerbatimUNC(server, share) => {
                        format!(
                            "\\\\{}\\{}",
                            server.to_string_lossy(),
                            share.to_string_lossy()
                        )
                    }
                    _ => value.as_os_str().to_string_lossy().into_owned(),
                }
                .to_lowercase();
            }
            Component::RootDir => rooted = true,
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(part) => parts.push(part.to_string_lossy().to_lowercase()),
        }
    }
    let mut normalized = prefix;
    if rooted {
        normalized.push('\\');
    }
    normalized.push_str(&parts.join("\\"));
    normalized
}

/// True when `candidate` sits inside one of `roots`, comparing on whole path
/// segments so `C:\Program Files` never matches `C:\Program Files Evil`. Bare
/// drive or share roots are ignored: trusting `C:\` would trust everything.
fn is_within_trusted_root(candidate: &Path, roots: &[PathBuf]) -> bool {
    let candidate = normalize_path(candidate);
    if candidate.is_empty() {
        return false;
    }
    roots.iter().any(|root| {
        let root = normalize_path(root);
        if root.is_empty() || root.ends_with('\\') {
            return false;
        }
        match candidate.strip_prefix(&root) {
            Some(remainder) => remainder.is_empty() || remainder.starts_with('\\'),
            None => false,
        }
    })
}

/// Directories an interpreter may be executed from. All of them are writable
/// only by administrators or by the installer, unlike the PATH and HKCU
/// entries that feed `discover_node`. `%ProgramFiles%` also covers the MSIX
/// package root, which lives under `%ProgramFiles%\WindowsApps`.
fn trusted_node_roots(
    lookup: &dyn Fn(&str) -> Option<OsString>,
    executable_directory: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = vec![windows_directory(lookup).join("System32")];
    for variable in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(value) = lookup(variable) {
            if !value.is_empty() {
                roots.push(PathBuf::from(value));
            }
        }
    }
    if let Some(value) = lookup("LOCALAPPDATA") {
        if !value.is_empty() {
            roots.push(PathBuf::from(value).join("Programs"));
        }
    }
    // The shim's own directory is the runtime directory the installer creates
    // and ACLs, so a node.exe staged beside the shim is as trusted as the shim.
    if let Some(directory) = executable_directory {
        roots.push(directory.to_path_buf());
    }
    roots
}

fn process_trusted_node_roots() -> Vec<PathBuf> {
    let executable = env::current_exe().ok();
    let directory = executable.as_deref().and_then(Path::parent);
    trusted_node_roots(&environment, directory)
}

fn hidden_output(command: &Path, arguments: &[&str]) -> Option<String> {
    Command::new(command)
        .args(arguments)
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
}

fn parse_registry_node_path(output: &str) -> Option<PathBuf> {
    let install_path = output
        .lines()
        .find_map(|line| line.split_once("REG_SZ").map(|(_, value)| value.trim()))
        .filter(|value| !value.is_empty())?;
    Some(PathBuf::from(install_path).join("node.exe"))
}

fn registry_node_path(key: &str) -> Option<PathBuf> {
    let reg = system_executable("reg.exe", &environment);
    parse_registry_node_path(&hidden_output(&reg, &["query", key, "/ve"])?)
}

fn discover_node(configured: PathBuf) -> io::Result<PathBuf> {
    // The configured interpreter comes from meetron-host.conf, which the
    // installer writes beside this shim and ACLs to the installing user, so it
    // is authoritative when it still resolves. Everything below it is ambient
    // input an attacker can influence (HKCU keys, PATH order), and is executed
    // only from a trusted root.
    if configured.is_absolute() && configured.is_file() {
        return Ok(configured);
    }
    let mut candidates = Vec::new();
    if let Ok(executable) = env::current_exe() {
        candidates.push(executable.with_file_name("node.exe"));
    }
    for key in [
        "HKCU\\Software\\Node.js",
        "HKLM\\Software\\Node.js",
        "HKLM\\Software\\WOW6432Node\\Node.js",
    ] {
        if let Some(candidate) = registry_node_path(key) {
            candidates.push(candidate);
        }
    }
    let where_executable = system_executable("where.exe", &environment);
    if let Some(output) = hidden_output(&where_executable, &["node.exe"]) {
        candidates.extend(
            output
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(PathBuf::from),
        );
    }
    if let Some(program_files) = env::var_os("ProgramFiles") {
        candidates.push(PathBuf::from(program_files).join("nodejs").join("node.exe"));
    }
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
        candidates.push(
            PathBuf::from(local_app_data)
                .join("Programs")
                .join("nodejs")
                .join("node.exe"),
        );
    }
    let roots = process_trusted_node_roots();
    candidates
        .into_iter()
        .find(|candidate| {
            candidate.is_absolute()
                && candidate.is_file()
                && is_within_trusted_root(candidate, &roots)
        })
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "no Node.js executable was found in a trusted install location",
            )
        })
}

fn run() -> Result<i32, String> {
    let (configured_node, script) = read_config(&config_path().map_err(|error| error.to_string())?)
        .map_err(|error| format!("Could not load meetron-host.conf: {error}"))?;
    let node = discover_node(configured_node)
        .map_err(|error| format!("Could not find Node.js for the Meetron host: {error}"))?;
    let _job = create_kill_on_close_job()
        .map_err(|error| format!("Could not create the Meetron process Job Object: {error}"))?;
    let status = Command::new(node)
        .arg(script)
        // Chrome passes the calling extension origin (and --parent-window) to the
        // Native Messaging host. The Node host rejects any caller whose origin
        // argument is missing, so the shim must forward its own arguments.
        .args(env::args_os().skip(1))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .creation_flags(CREATE_NO_WINDOW.0)
        .status()
        .map_err(|error| format!("Could not start the Meetron Native Messaging host: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_lookup(
        entries: Vec<(&'static str, &'static str)>,
    ) -> impl Fn(&str) -> Option<OsString> {
        move |name| {
            entries
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(*value))
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let mut path = env::temp_dir();
        path.push(format!("meetron-host-{}-{}", label, std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create the temporary directory");
        path
    }

    #[test]
    fn windows_directory_prefers_system_root_then_windir_then_default() {
        let both = fake_lookup(vec![("SystemRoot", "D:\\Win"), ("windir", "E:\\Other")]);
        assert_eq!(windows_directory(&both), PathBuf::from("D:\\Win"));

        let empty_system_root = fake_lookup(vec![("SystemRoot", ""), ("windir", "E:\\Other")]);
        assert_eq!(
            windows_directory(&empty_system_root),
            PathBuf::from("E:\\Other")
        );

        let none = fake_lookup(vec![]);
        assert_eq!(windows_directory(&none), PathBuf::from("C:\\Windows"));
    }

    #[test]
    fn system_executable_resolves_under_system32_absolutely() {
        let lookup = fake_lookup(vec![("SystemRoot", "D:\\Win")]);
        assert_eq!(
            system_executable("where.exe", &lookup),
            PathBuf::from("D:\\Win\\System32\\where.exe")
        );
        assert!(system_executable("reg.exe", &lookup).is_absolute());
    }

    #[test]
    fn normalize_path_folds_case_separators_and_dot_segments() {
        assert_eq!(
            normalize_path(Path::new("C:\\Program Files\\NodeJS\\node.exe")),
            "c:\\program files\\nodejs\\node.exe"
        );
        assert_eq!(
            normalize_path(Path::new("C:/Program Files/nodejs/./node.exe")),
            "c:\\program files\\nodejs\\node.exe"
        );
        assert_eq!(
            normalize_path(Path::new("C:\\Program Files\\..\\Temp\\node.exe")),
            "c:\\temp\\node.exe"
        );
        assert_eq!(
            normalize_path(Path::new("\\\\?\\C:\\Program Files")),
            "c:\\program files"
        );
        assert_eq!(normalize_path(Path::new("C:\\")), "c:\\");
        assert_eq!(normalize_path(Path::new("")), "");
    }

    #[test]
    fn trusted_root_accepts_the_root_itself_and_its_descendants() {
        let roots = vec![PathBuf::from("C:\\Program Files")];
        assert!(is_within_trusted_root(
            Path::new("C:\\Program Files"),
            &roots
        ));
        assert!(is_within_trusted_root(
            Path::new("c:\\program files\\nodejs\\node.exe"),
            &roots
        ));
        assert!(is_within_trusted_root(
            Path::new("C:/Program Files/WindowsApps/Meetron_1.0.0_x64__abc/node.exe"),
            &roots
        ));
    }

    #[test]
    fn trusted_root_rejects_untrusted_and_escaping_candidates() {
        let roots = vec![PathBuf::from("C:\\Program Files")];
        // A sibling directory that merely shares a textual prefix.
        assert!(!is_within_trusted_root(
            Path::new("C:\\Program Files Evil\\node.exe"),
            &roots
        ));
        // A PATH entry any process can write to.
        assert!(!is_within_trusted_root(
            Path::new("C:\\Users\\victim\\Downloads\\node.exe"),
            &roots
        ));
        // A traversal that leaves the root once `..` is folded away.
        assert!(!is_within_trusted_root(
            Path::new("C:\\Program Files\\..\\Users\\victim\\node.exe"),
            &roots
        ));
        // Relative paths never match, and no root ever trusts a bare drive.
        assert!(!is_within_trusted_root(Path::new("node.exe"), &roots));
        assert!(!is_within_trusted_root(
            Path::new("C:\\Users\\victim\\node.exe"),
            &[PathBuf::from("C:\\")]
        ));
        assert!(!is_within_trusted_root(Path::new("C:\\x\\node.exe"), &[]));
    }

    #[test]
    fn trusted_node_roots_cover_system32_program_files_and_the_shim_directory() {
        let lookup = fake_lookup(vec![
            ("SystemRoot", "C:\\Windows"),
            ("ProgramFiles", "C:\\Program Files"),
            ("ProgramFiles(x86)", "C:\\Program Files (x86)"),
            ("ProgramW6432", "C:\\Program Files"),
            ("LOCALAPPDATA", "C:\\Users\\victim\\AppData\\Local"),
        ]);
        let shim = PathBuf::from("C:\\Users\\victim\\AppData\\Local\\Meetron\\Runtime");
        let roots = trusted_node_roots(&lookup, Some(&shim));

        for trusted in [
            "C:\\Windows\\System32\\node.exe",
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Program Files (x86)\\nodejs\\node.exe",
            "C:\\Users\\victim\\AppData\\Local\\Programs\\nodejs\\node.exe",
            "C:\\Users\\victim\\AppData\\Local\\Meetron\\Runtime\\node.exe",
        ] {
            assert!(
                is_within_trusted_root(Path::new(trusted), &roots),
                "expected {trusted} to be trusted"
            );
        }
        for untrusted in [
            // %LOCALAPPDATA% itself is not trusted, only its Programs subtree.
            "C:\\Users\\victim\\AppData\\Local\\Temp\\node.exe",
            "C:\\Windows\\Temp\\node.exe",
        ] {
            assert!(
                !is_within_trusted_root(Path::new(untrusted), &roots),
                "expected {untrusted} to be rejected"
            );
        }
    }

    #[test]
    fn trusted_node_roots_skip_empty_variables_and_a_missing_shim_directory() {
        let lookup = fake_lookup(vec![("SystemRoot", "C:\\Windows"), ("ProgramFiles", "")]);
        let roots = trusted_node_roots(&lookup, None);
        assert_eq!(roots, vec![PathBuf::from("C:\\Windows\\System32")]);
    }

    #[test]
    fn parse_registry_node_path_reads_the_default_value() {
        let output = "\r\nHKEY_LOCAL_MACHINE\\Software\\Node.js\r\n    (Default)    REG_SZ    C:\\Program Files\\nodejs\\\r\n\r\n";
        assert_eq!(
            parse_registry_node_path(output),
            Some(PathBuf::from("C:\\Program Files\\nodejs\\node.exe"))
        );
        assert_eq!(parse_registry_node_path(""), None);
        assert_eq!(parse_registry_node_path("ERROR: key not found\r\n"), None);
        assert_eq!(
            parse_registry_node_path("    (Default)    REG_SZ    \r\n"),
            None
        );
    }

    #[test]
    fn read_config_returns_the_node_and_script_paths() {
        let directory = temporary_directory("config-ok");
        let script = directory.join("native-host.mjs");
        fs::write(&script, "// host").expect("write the script");
        let config = directory.join("meetron-host.conf");
        fs::write(
            &config,
            format!(
                "C:\\Program Files\\nodejs\\node.exe\r\n{}\r\n",
                script.display()
            ),
        )
        .expect("write the config");

        let (node, resolved) = read_config(&config).expect("read the config");
        assert_eq!(node, PathBuf::from("C:\\Program Files\\nodejs\\node.exe"));
        assert_eq!(resolved, script);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn read_config_rejects_a_relative_script_path() {
        let directory = temporary_directory("config-relative");
        let config = directory.join("meetron-host.conf");
        fs::write(&config, "node.exe\r\nnative-host.mjs\r\n").expect("write the config");

        let error = read_config(&config).expect_err("a relative script must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn read_config_rejects_a_missing_script_and_a_missing_config() {
        let directory = temporary_directory("config-missing");
        let config = directory.join("meetron-host.conf");
        fs::write(
            &config,
            format!("node.exe\r\n{}\r\n", directory.join("absent.mjs").display()),
        )
        .expect("write the config");

        let error = read_config(&config).expect_err("a missing script must be rejected");
        assert_eq!(error.kind(), io::ErrorKind::NotFound);

        let absent = directory.join("absent.conf");
        assert_eq!(
            read_config(&absent)
                .expect_err("a missing config must fail")
                .kind(),
            io::ErrorKind::NotFound
        );
        let _ = fs::remove_dir_all(&directory);
    }
}
