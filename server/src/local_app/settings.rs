//! Integrates local application settings.
use std::{collections::BTreeMap, fs, path::PathBuf};

use serde_json::Value;

use crate::{Error, Result};

const NO_PROXY_KEY: &str = "http.noProxy";
const REMOTE_INFERENCE_ROUTE: &str = "always";
const KEYS: [&str; 6] = [
    "http.proxy",
    "http.proxyKerberosServicePrincipal",
    "http.proxySupport",
    "cursor.general.disableHttp2",
    "http.experimental.systemCertificatesV2",
    "cursorAgentHost.remoteInferenceRoute",
];

fn path() -> Result<PathBuf> {
    let home = dirs::home_dir()
        .ok_or_else(|| Error::Config("cannot resolve user home directory".into()))?;
    match std::env::consts::OS {
        "macos" => Ok(home.join("Library/Application Support/Cursor/User/settings.json")),
        "windows" => Ok(std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData/Roaming"))
            .join("Cursor/User/settings.json")),
        "linux" => Ok(std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"))
            .join("Cursor/User/settings.json")),
        platform => Err(Error::Config(format!(
            "Cursor settings are unsupported on {platform}"
        ))),
    }
}

fn read() -> Result<BTreeMap<String, Value>> {
    let path = path()?;
    let data = match fs::read_to_string(path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.into()),
    };
    if data.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    json5::from_str(&data)
        .map_err(|error| Error::Config(format!("parse Cursor settings JSONC: {error}")))
}

fn write(settings: &BTreeMap<String, Value>) -> Result<()> {
    let path = path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = serde_json::to_vec_pretty(settings)?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, [data.as_slice(), b"\n"].concat())?;
    fs::rename(temp, path)?;
    Ok(())
}

pub fn write_proxy_settings(proxy_url: &str) -> Result<()> {
    let mut settings = read()?;
    settings.remove(NO_PROXY_KEY);
    settings.insert(KEYS[0].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[1].into(), Value::String(proxy_url.into()));
    settings.insert(KEYS[2].into(), Value::String("on".into()));
    settings.insert(KEYS[3].into(), Value::Bool(true));
    settings.insert(KEYS[4].into(), Value::Bool(true));
    // Remote-SSH AgentService must dial through the local Cursor client so the
    // local BYOK proxy and model catalog are visible on the remote window.
    settings.insert(KEYS[5].into(), Value::String(REMOTE_INFERENCE_ROUTE.into()));
    write(&settings)
}

pub fn settings_match(proxy_url: &str) -> Result<bool> {
    let settings = read()?;
    Ok(
        settings.get(KEYS[0]) == Some(&Value::String(proxy_url.into()))
            && settings.get(KEYS[1]) == Some(&Value::String(proxy_url.into()))
            && settings.get(KEYS[2]) == Some(&Value::String("on".into()))
            && settings.get(KEYS[3]) == Some(&Value::Bool(true))
            && settings.get(KEYS[4]) == Some(&Value::Bool(true))
            && settings.get(KEYS[5]) == Some(&Value::String(REMOTE_INFERENCE_ROUTE.into())),
    )
}

pub fn clear_stale_managed_settings(port: u16) -> Result<()> {
    let mut settings = read()?;
    if remove_managed(&mut settings, port) {
        write(&settings)?;
    }
    Ok(())
}

fn remove_managed(settings: &mut BTreeMap<String, Value>, port: u16) -> bool {
    let url = Value::String(format!("http://127.0.0.1:{port}"));
    if port == 0 || settings.get(KEYS[1]) != Some(&url) || settings.get(KEYS[0]) != Some(&url) {
        return false;
    }
    settings.remove(KEYS[0]);
    settings.remove(KEYS[1]);
    for (key, expected) in [
        (KEYS[2], Value::String("on".into())),
        (KEYS[3], Value::Bool(true)),
        (KEYS[4], Value::Bool(true)),
        (KEYS[5], Value::String(REMOTE_INFERENCE_ROUTE.into())),
    ] {
        if settings.get(key) == Some(&expected) {
            settings.remove(key);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disconnect_removes_the_owned_loopback_proxy_even_if_the_route_was_changed() {
        let url = Value::String("http://127.0.0.1:12345".into());
        let mut settings = BTreeMap::from([
            (KEYS[0].into(), url.clone()),
            (KEYS[1].into(), url),
            (KEYS[5].into(), Value::String("never".into())),
        ]);
        assert!(remove_managed(&mut settings, 12345));
        assert!(!settings.contains_key(KEYS[0]));
        assert_eq!(settings[KEYS[5]], "never");
        let mut other = BTreeMap::from([(
            KEYS[0].into(),
            Value::String("http://127.0.0.1:8080".into()),
        )]);
        assert!(!remove_managed(&mut other, 12345));
        assert!(other.contains_key(KEYS[0]));
    }

    #[test]
    fn disconnect_preserves_matching_urls_owned_by_another_proxy() {
        let other_url = Value::String("http://127.0.0.1:8080".into());
        let mut settings = BTreeMap::from([
            (KEYS[0].into(), other_url.clone()),
            (KEYS[1].into(), other_url),
        ]);
        let original = settings.clone();
        assert!(!remove_managed(&mut settings, 12345));
        assert_eq!(settings, original);
    }
}
