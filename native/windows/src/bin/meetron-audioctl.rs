use serde::Serialize;
use std::env;
use std::ffi::c_void;
use std::process::ExitCode;
use windows::core::{Interface, PCWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eMultimedia, eRender, EDataFlow, ERole, IMMDevice,
    IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};

const VERSION: &str = "0.1.0";
const POLICY_CONFIG_CLSID: windows::core::GUID =
    windows::core::GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
const VB_CABLE_NAMES: [&str; 4] = [
    "CABLE-A Input (VB-Audio Cable A)",
    "CABLE-A Output (VB-Audio Cable A)",
    "CABLE-B Input (VB-Audio Cable B)",
    "CABLE-B Output (VB-Audio Cable B)",
];

windows::core::imp::define_interface!(
    IPolicyConfig,
    IPolicyConfig_Vtbl,
    0xf8679f50_850a_41cf_9c72_430f290290c8
);
impl std::ops::Deref for IPolicyConfig {
    type Target = windows::core::IUnknown;
    fn deref(&self) -> &Self::Target {
        unsafe { std::mem::transmute(self) }
    }
}
windows::core::imp::interface_hierarchy!(IPolicyConfig, windows::core::IUnknown);

#[repr(C)]
#[allow(non_snake_case)]
pub struct IPolicyConfig_Vtbl {
    base__: windows::core::IUnknown_Vtbl,
    unused_before_set_default_endpoint: [usize; 10],
    SetDefaultEndpoint:
        unsafe extern "system" fn(*mut c_void, PCWSTR, ERole) -> windows::core::HRESULT,
}

impl IPolicyConfig {
    unsafe fn set_default_endpoint(
        &self,
        endpoint_id: PCWSTR,
        role: ERole,
    ) -> windows::core::Result<()> {
        (Interface::vtable(self).SetDefaultEndpoint)(Interface::as_raw(self), endpoint_id, role)
            .ok()
    }
}

struct Com;

impl Com {
    fn initialize() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        Ok(Self)
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioDevice {
    id: u32,
    uid: String,
    name: String,
    has_input: bool,
    has_output: bool,
}

#[derive(Serialize)]
struct AudioSystemStatus {
    input: Option<AudioDevice>,
    output: Option<AudioDevice>,
    devices: Vec<AudioDevice>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandResult {
    changed: bool,
    device: AudioDevice,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallStatus {
    installed: bool,
    required_uids: std::collections::BTreeMap<String, bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoutingVerification {
    ready: bool,
    default_input_uid: Option<String>,
    default_output_uid: Option<String>,
    meeting_to_ai_installed: bool,
    ai_to_meeting_installed: bool,
    meetron_is_default_input: bool,
    meetron_is_default_output: bool,
}

fn endpoint_id(device: &IMMDevice) -> windows::core::Result<String> {
    unsafe {
        let value = device.GetId()?;
        let result = value.to_string();
        CoTaskMemFree(Some(value.0 as *const c_void));
        Ok(result?)
    }
}

fn endpoint_name(device: &IMMDevice) -> windows::core::Result<String> {
    unsafe {
        let store = device.OpenPropertyStore(STGM_READ)?;
        Ok(store.GetValue(&PKEY_Device_FriendlyName)?.to_string())
    }
}

fn device_from_endpoint(
    endpoint: &IMMDevice,
    id: u32,
    flow: EDataFlow,
) -> windows::core::Result<AudioDevice> {
    Ok(AudioDevice {
        id,
        uid: endpoint_id(endpoint)?,
        name: endpoint_name(endpoint)?,
        has_input: flow == eCapture,
        has_output: flow == eRender,
    })
}

fn enumerate_flow(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
    next_id: &mut u32,
) -> windows::core::Result<Vec<AudioDevice>> {
    unsafe {
        let collection = enumerator.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE)?;
        let mut devices = Vec::new();
        for index in 0..collection.GetCount()? {
            devices.push(device_from_endpoint(
                &collection.Item(index)?,
                *next_id,
                flow,
            )?);
            *next_id += 1;
        }
        Ok(devices)
    }
}

fn default_endpoint(
    enumerator: &IMMDeviceEnumerator,
    flow: EDataFlow,
    devices: &[AudioDevice],
) -> Option<AudioDevice> {
    let uid = unsafe { enumerator.GetDefaultAudioEndpoint(flow, eConsole) }
        .ok()
        .and_then(|device| endpoint_id(&device).ok())?;
    devices.iter().find(|device| device.uid == uid).cloned()
}

fn status(enumerator: &IMMDeviceEnumerator) -> windows::core::Result<AudioSystemStatus> {
    let mut next_id = 1;
    let mut devices = enumerate_flow(enumerator, eCapture, &mut next_id)?;
    devices.extend(enumerate_flow(enumerator, eRender, &mut next_id)?);
    devices.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(AudioSystemStatus {
        input: default_endpoint(enumerator, eCapture, &devices),
        output: default_endpoint(enumerator, eRender, &devices),
        devices,
    })
}

fn required_status(devices: &[AudioDevice]) -> std::collections::BTreeMap<String, bool> {
    VB_CABLE_NAMES
        .iter()
        .map(|name| {
            (
                (*name).to_owned(),
                devices.iter().any(|device| device.name == *name),
            )
        })
        .collect()
}

fn set_default(uid: &str, devices: &[AudioDevice], input: bool) -> Result<AudioDevice, String> {
    let device = devices
        .iter()
        .find(|device| device.uid == uid)
        .ok_or_else(|| format!("Audio device was not found: {uid}"))?;
    if input && !device.has_input {
        return Err(format!("Audio device {uid} does not support input"));
    }
    if !input && !device.has_output {
        return Err(format!("Audio device {uid} does not support output"));
    }
    let wide: Vec<u16> = uid.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let policy: IPolicyConfig = CoCreateInstance(&POLICY_CONFIG_CLSID, None, CLSCTX_ALL)
            .map_err(|error| {
                format!("Could not open the Windows audio policy interface: {error}")
            })?;
        for role in [eConsole, eMultimedia, eCommunications] {
            policy
                .set_default_endpoint(PCWSTR(wide.as_ptr()), role)
                .map_err(|error| format!("Could not set the default audio endpoint: {error}"))?;
        }
    }
    Ok(device.clone())
}

fn uid_argument(arguments: &[String]) -> Result<&str, String> {
    let index = arguments
        .iter()
        .position(|value| value == "--uid")
        .ok_or_else(|| "missing --uid".to_owned())?;
    arguments
        .get(index + 1)
        .map(String::as_str)
        .ok_or_else(|| "missing --uid".to_owned())
}

fn usage() {
    println!(
        "Usage: meetron-audioctl COMMAND [options]\n\n  status\n  list\n  install-status\n  get-default-input\n  set-default-input --uid UID\n  set-default-output --uid UID\n  verify-routing\n  version"
    );
}

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string_pretty(value).map_err(|error| error.to_string())
}

fn run() -> Result<String, String> {
    let arguments: Vec<String> = env::args().skip(1).collect();
    if arguments.is_empty() {
        usage();
        return Err("A command is required".to_owned());
    }
    if ["-h", "--help"].contains(&arguments[0].as_str()) {
        usage();
        return Ok(String::new());
    }
    let _com = Com::initialize().map_err(|error| error.to_string())?;
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|error| error.to_string())?
    };
    let current = status(&enumerator).map_err(|error| error.to_string())?;
    match arguments[0].as_str() {
        "status" => json(&current),
        "list" => json(&current.devices),
        "get-default-input" => json(&current.input),
        "set-default-input" => json(&CommandResult {
            changed: true,
            device: set_default(uid_argument(&arguments)?, &current.devices, true)?,
        }),
        "set-default-output" => json(&CommandResult {
            changed: true,
            device: set_default(uid_argument(&arguments)?, &current.devices, false)?,
        }),
        "install-status" => {
            let required_uids = required_status(&current.devices);
            json(&InstallStatus {
                installed: required_uids.values().all(|installed| *installed),
                required_uids,
            })
        }
        "verify-routing" => {
            let required = required_status(&current.devices);
            let meeting_to_ai_installed =
                required[VB_CABLE_NAMES[0]] && required[VB_CABLE_NAMES[1]];
            let ai_to_meeting_installed =
                required[VB_CABLE_NAMES[2]] && required[VB_CABLE_NAMES[3]];
            let required_names = |device: &Option<AudioDevice>| {
                device
                    .as_ref()
                    .is_some_and(|value| VB_CABLE_NAMES.contains(&value.name.as_str()))
            };
            json(&RoutingVerification {
                ready: meeting_to_ai_installed && ai_to_meeting_installed,
                default_input_uid: current.input.as_ref().map(|device| device.uid.clone()),
                default_output_uid: current.output.as_ref().map(|device| device.uid.clone()),
                meeting_to_ai_installed,
                ai_to_meeting_installed,
                meetron_is_default_input: required_names(&current.input),
                meetron_is_default_output: required_names(&current.output),
            })
        }
        "version" => json(&serde_json::json!({ "version": VERSION })),
        command => Err(format!("Unknown command: {command}")),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(output) => {
            if !output.is_empty() {
                println!("{output}");
            }
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{}", serde_json::json!({ "error": message }));
            ExitCode::FAILURE
        }
    }
}
