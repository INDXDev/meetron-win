#![windows_subsystem = "windows"]

use std::env;
use std::fs;
use std::io;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
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

fn hidden_output(command: &str, arguments: &[&str]) -> Option<String> {
    Command::new(command)
        .args(arguments)
        .creation_flags(CREATE_NO_WINDOW.0)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
}

fn registry_node_path(key: &str) -> Option<PathBuf> {
    let output = hidden_output("reg.exe", &["query", key, "/ve"])?;
    let install_path = output
        .lines()
        .find_map(|line| line.split_once("REG_SZ").map(|(_, value)| value.trim()))?;
    Some(PathBuf::from(install_path).join("node.exe"))
}

fn discover_node(configured: PathBuf) -> io::Result<PathBuf> {
    let mut candidates = vec![configured];
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
    if let Some(output) = hidden_output("where.exe", &["node.exe"]) {
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
    candidates
        .into_iter()
        .find(|candidate| candidate.is_absolute() && candidate.is_file())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Node.js executable was not found"))
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
