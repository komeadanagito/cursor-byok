//! Reports and installs the workspace-symbols VSIX that carries byok-semantic into Cursor.
//!
//! Cursor discovers installed extensions from `~/.cursor/extensions/extensions.json`,
//! a JSON list of `{identifier: {id}, version, location: {fsPath}}` entries, and
//! extracts each side-loaded VSIX into a sibling `<id>-<version>` directory.
//! Installation itself goes through the `cursor` CLI (`--install-extension --force`),
//! so this module only needs the CLI path, the release asset URL and a checksum.
use std::path::PathBuf;

use serde::Serialize;
use sha2::Digest;
use tokio::sync::Mutex;

use crate::error::{Error, Result};

/// Extension identifier as it appears in extensions.json.
pub const EXTENSION_ID: &str = "cursor-byok.byok-workspace-symbols";
/// Release asset name for a given app version, e.g. `byok-workspace-symbols-1.1.0.vsix`.
pub fn vsix_asset_name(version: &str) -> String {
    format!("byok-workspace-symbols-{version}.vsix")
}

/// Base URL of the GitHub release holding the VSIX assets.
pub const DEFAULT_RELEASE_URL: &str =
    "https://github.com/komeadanagito/cursor-byok/releases/download";

/// Where the `cursor` CLI may live when it is not on PATH. Paths were confirmed
/// against a stock Cursor install: Cursor ships `app/bin/{cursor,code,cursor-tunnel}`
/// inside the .app bundle on macOS, registers a `cursor` shim in ~/.local/bin or
/// the install prefix on Linux, and installs `cursor.cmd` under
/// %LOCALAPPDATA%\Programs\Cursor\resources\app\bin on Windows.
fn cli_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    {
        candidates.push("/Applications/Cursor.app/Contents/Resources/app/bin/cursor".into());
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications/Cursor.app/Contents/Resources/app/bin/cursor"));
        }
    }
    #[cfg(target_os = "windows")]
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local).join("Programs/Cursor/resources/app/bin/cursor.cmd"));
    }
    for entry in std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
    {
        #[cfg(target_os = "windows")]
        {
            candidates.push(entry.join("cursor.cmd"));
            candidates.push(entry.join("cursor.exe"));
        }
        #[cfg(not(target_os = "windows"))]
        candidates.push(entry.join("cursor"));
    }
    candidates
}

/// Injectable cursor CLI location for tests.
#[derive(Clone, Debug)]
pub enum CursorCli {
    /// Search the default install paths and PATH.
    Detect,
    /// Exactly this path, when it exists.
    Fixed(PathBuf),
    /// Pretend no CLI is installed.
    Unavailable,
}

/// Installed-version snapshot plus the state the desktop UI acts on.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkspaceExtensionStatus {
    pub state: String,
    pub installed_version: Option<String>,
    pub expected_version: String,
    pub cursor_cli: bool,
}

pub struct WorkspaceExtensions {
    /// Semver-ish string the VSIX at the release URL provides; the desktop app
    /// version and the extension version are pinned together by a check in
    /// apps/workspace-symbols, so they never drift here.
    expected_version: String,
    /// Download base URL — the release assets live at
    /// `<release_url>/<asset>` and `<release_url>/<asset>.sha256`.
    release_url: String,
    extensions_dir: PathBuf,
    cli: CursorCli,
    downloads_dir: PathBuf,
    /// Store for the shared, proxy-aware outbound client; None in tests where
    /// the release URL already points at a local fake server.
    store: Option<crate::store::Store>,
    /// Downloading + installing is slow enough that a double-click must not
    /// start a second one; the lock serializes install/save calls.
    operation: Mutex<()>,
}

impl WorkspaceExtensions {
    /// Production wiring: real extensions dir, real CLI detection, user Downloads.
    pub fn managed(store: crate::store::Store, expected_version: String) -> Result<Self> {
        let home = dirs::home_dir()
            .ok_or_else(|| Error::Config("cannot locate the home directory".into()))?;
        Ok(Self {
            store: Some(store),
            ..Self::new(
                expected_version,
                DEFAULT_RELEASE_URL.into(),
                home.join(".cursor").join("extensions"),
                CursorCli::Detect,
                dirs::download_dir().unwrap_or_else(|| home.join("Downloads")),
            )
        })
    }

    /// Test wiring: every external touchpoint is a constructor argument.
    pub fn new(
        expected_version: String,
        release_url: String,
        extensions_dir: PathBuf,
        cli: CursorCli,
        downloads_dir: PathBuf,
    ) -> Self {
        Self {
            expected_version,
            release_url,
            extensions_dir,
            cli,
            downloads_dir,
            store: None,
            operation: Mutex::new(()),
        }
    }

    pub async fn status(&self) -> Result<WorkspaceExtensionStatus> {
        let installed_version = self.installed_version().await?;
        let state = match installed_version.as_deref() {
            None => "missing",
            Some(v) if v == self.expected_version => "current",
            Some(_) => "outdated",
        };
        Ok(WorkspaceExtensionStatus {
            state: state.into(),
            installed_version,
            expected_version: self.expected_version.clone(),
            cursor_cli: self.resolve_cli().is_some(),
        })
    }

    /// Downloads the VSIX, verifies the sha256 sidecar, then shells out to the
    /// cursor CLI. Returns the refreshed status so the UI can update in place.
    pub async fn install(&self) -> Result<WorkspaceExtensionStatus> {
        let _op = self.operation.lock().await;
        let cli = self.resolve_cli().ok_or_else(|| {
            Error::Config(
                "Cursor CLI (`cursor`) was not found; install the extension manually with Extensions: Install from VSIX".into(),
            )
        })?;
        let vsix = self.download().await?;
        let _download_cleanup = DownloadCleanup { path: vsix.clone() };
        // The CLI writes into ~/.cursor/extensions itself, so its stderr is the
        // actionable part of a failure — keep it verbatim for the UI.
        #[cfg(target_os = "windows")]
        let mut command = {
            // .cmd shims cannot be spawned directly by Command::new.
            let mut cmd = std::process::Command::new("cmd");
            cmd.arg("/c").arg(&cli);
            cmd
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = std::process::Command::new(&cli);
        command.arg("--install-extension").arg(&vsix).arg("--force");
        let output = tokio::task::spawn_blocking(move || command.output())
            .await
            .map_err(|e| Error::Store(format!("cursor CLI task failed: {e}")))?
            .map_err(|e| Error::Config(format!("failed to run Cursor CLI: {e}")))?;
        drop(_download_cleanup);
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(Error::Config(format!(
                "cursor --install-extension failed ({status}): {stderr}",
                status = output.status,
                stderr = if stderr.is_empty() {
                    "no output".into()
                } else {
                    stderr
                },
            )));
        }
        self.status().await
    }

    /// Same download + checksum, but saves to the downloads dir for manual install.
    pub async fn save_vsix(&self) -> Result<PathBuf> {
        let _op = self.operation.lock().await;
        let vsix = self.download().await?;
        let _download_cleanup = DownloadCleanup { path: vsix.clone() };
        std::fs::create_dir_all(&self.downloads_dir).map_err(Error::Io)?;
        let target = self
            .downloads_dir
            .join(vsix_asset_name(&self.expected_version));
        std::fs::copy(&vsix, &target).map_err(Error::Io)?;
        Ok(target)
    }

    /// Read the installed version out of extensions.json. Cursor writes this
    /// manifest whenever it installs an extension, so a missing manifest is a
    /// genuine "not installed" — no directory-name guessing needed.
    async fn installed_version(&self) -> Result<Option<String>> {
        let manifest = self.extensions_dir.join("extensions.json");
        match std::fs::read_to_string(&manifest) {
            Ok(contents) => {
                let entries: serde_json::Value = serde_json::from_str(&contents).map_err(|e| {
                    Error::Config(format!("cannot parse {}: {e}", manifest.display()))
                })?;
                let version = entries
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .find(|entry| {
                        entry.pointer("/identifier/id").and_then(|id| id.as_str())
                            == Some(EXTENSION_ID)
                    })
                    .and_then(|entry| entry.get("version"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                Ok(version)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Io(e)),
        }
    }

    fn resolve_cli(&self) -> Option<PathBuf> {
        match &self.cli {
            CursorCli::Unavailable => None,
            CursorCli::Fixed(path) => path.is_file().then(|| path.clone()),
            CursorCli::Detect => cli_candidates().into_iter().find(|p| p.is_file()),
        }
    }

    /// Fetch `<name>` and `<name>.sha256` from the release, verify, and return
    /// the verified temp file path.
    async fn download(&self) -> Result<PathBuf> {
        let name = vsix_asset_name(&self.expected_version);
        let vsix = self.fetch(&format!("{}/{name}", self.release_url)).await?;
        let expected = self
            .fetch(&format!("{}/{name}.sha256", self.release_url))
            .await?;
        let expected = parse_sha256(&expected).ok_or_else(|| {
            Error::Provider(format!("release checksum for {name} is not a sha256 line"))
        })?;
        let actual = hex::encode(sha2::Sha256::digest(&vsix));
        if actual != expected {
            return Err(Error::Provider(format!(
                "sha256 mismatch for {name}: expected {expected}, got {actual}"
            )));
        }
        // Unique temp dir per download: parallel installs/tests must not share
        // one file, and the CLI gets a path ending in the real asset name.
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "byok-wse-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).map_err(Error::Io)?;
        let path = dir.join(&name);
        std::fs::write(&path, &vsix).map_err(Error::Io)?;
        Ok(path)
    }

    /// Outbound client: proxy-aware in production, plain in tests.
    async fn client(&self) -> Result<reqwest::Client> {
        let builder = match &self.store {
            Some(store) => crate::network::client_builder(store).await?,
            None => reqwest::Client::builder(),
        };
        Ok(builder
            .timeout(std::time::Duration::from_secs(300))
            .build()?)
    }

    async fn fetch(&self, url: &str) -> Result<Vec<u8>> {
        let response = self
            .client()
            .await?
            .get(url)
            .send()
            .await
            .map_err(|e| Error::Provider(format!("cannot reach {url}: {e}")))?;
        if !response.status().is_success() {
            return Err(Error::Provider(format!(
                "downloading {url} failed with HTTP {}",
                response.status()
            )));
        }
        response
            .bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| Error::Provider(format!("reading {url} failed: {e}")))
    }
}

/// Removes the downloaded VSIX and its scratch directory when dropped, so
/// every install/save exit path — success or error — cleans up.
struct DownloadCleanup {
    path: PathBuf,
}

impl Drop for DownloadCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
    }
}

/// Leading hex token of a sha256sum line (`<64 hex>  <name>`), lowercased.
fn parse_sha256(contents: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(contents);
    let token = text.split_whitespace().next()?;
    (token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()))
        .then(|| token.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::Path;

    fn tempdir(tag: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        // Tests run in parallel inside one process, so a per-PID-only directory
        // name would make every fixture point at the same path.
        let dir = std::env::temp_dir().join(format!(
            "byok-wse-{tag}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    fn fake_cli(dir: &Path, unix_script: &str, _win_script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;

        let path = dir.join("cursor-fake");
        std::fs::write(&path, unix_script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(windows)]
    fn fake_cli(dir: &Path, _unix_script: &str, win_script: &str) -> PathBuf {
        let path = dir.join("cursor-fake.cmd");
        std::fs::write(&path, win_script).unwrap();
        path
    }

    /// Writes an extensions.json list containing one entry.
    fn write_manifest(extensions_dir: &Path, id: &str, version: &str) {
        std::fs::create_dir_all(extensions_dir).unwrap();
        std::fs::write(
            extensions_dir.join("extensions.json"),
            serde_json::json!([{
                "identifier": { "id": id },
                "version": version,
                "location": { "fsPath": extensions_dir.join(format!("{id}-{version}")).to_string_lossy() },
                "metadata": null,
            }])
            .to_string(),
        )
        .unwrap();
    }

    /// Tiny HTTP server serving `asset` and `asset.sha256` from `dir`.
    struct FakeRelease {
        base_url: String,
        join: Option<std::thread::JoinHandle<()>>,
    }

    impl FakeRelease {
        fn serve(dir: PathBuf, asset: &str) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let asset = asset.to_string();
            let join = std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buf = [0u8; 4096];
                    let request = {
                        use std::io::Read;
                        let n = stream.read(&mut buf).unwrap_or(0);
                        String::from_utf8_lossy(&buf[..n]).to_string()
                    };
                    let path = request
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .trim_start_matches('/')
                        .to_string();
                    let file = dir.join(&path);
                    let (status, body) = if path == asset || path == format!("{asset}.sha256") {
                        match std::fs::read(&file) {
                            Ok(bytes) => ("200 OK", bytes),
                            Err(_) => ("404 Not Found", b"missing".to_vec()),
                        }
                    } else {
                        ("404 Not Found", b"unknown".to_vec())
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.write_all(&body);
                }
            });
            Self {
                base_url: format!("http://127.0.0.1:{port}"),
                join: Some(join),
            }
        }
    }

    impl Drop for FakeRelease {
        fn drop(&mut self) {
            // The listener thread blocks on incoming() forever; detach so tests
            // exit promptly. The temp files it may still read are cleaned by the
            // OS when the process exits.
            self.join.take();
        }
    }

    fn fixture() -> (PathBuf, PathBuf, PathBuf) {
        (tempdir("ext"), tempdir("dl"), tempdir("rel"))
    }

    #[tokio::test]
    async fn status_is_missing_without_an_installed_extension() {
        let (ext, dl, _rel) = fixture();
        let wse = WorkspaceExtensions::new(
            "1.1.0".into(),
            "http://unused".into(),
            ext,
            CursorCli::Unavailable,
            dl,
        );
        let status = wse.status().await.unwrap();
        assert_eq!(status.state, "missing");
        assert_eq!(status.installed_version, None);
        assert_eq!(status.expected_version, "1.1.0");
        assert!(!status.cursor_cli);
    }

    /// Extension id comes from apps/workspace-symbols/package.json
    /// (`<publisher>.<name>`) — pin it here so a typo in EXTENSION_ID cannot
    /// silently make every status check report "missing".
    #[test]
    fn extension_id_matches_the_vscode_package() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../apps/workspace-symbols/package.json"))
                .unwrap();
        let id = format!(
            "{}.{}",
            manifest["publisher"].as_str().unwrap(),
            manifest["name"].as_str().unwrap()
        );
        assert_eq!(EXTENSION_ID, id);
    }

    #[tokio::test]
    async fn status_reads_the_manifest_and_marks_current_and_outdated() {
        let (ext, dl, _) = fixture();
        write_manifest(&ext, "cursor-byok.byok-workspace-symbols", "1.1.0");
        let current = WorkspaceExtensions::new(
            "1.1.0".into(),
            "http://unused".into(),
            ext.clone(),
            CursorCli::Unavailable,
            dl.clone(),
        );
        assert_eq!(current.status().await.unwrap().state, "current");
        assert_eq!(
            current.status().await.unwrap().installed_version.as_deref(),
            Some("1.1.0")
        );

        let ext2 = tempdir("outdated");
        write_manifest(&ext2, "cursor-byok.byok-workspace-symbols", "0.9.0");
        let outdated = WorkspaceExtensions::new(
            "1.1.0".into(),
            "http://unused".into(),
            ext2,
            CursorCli::Unavailable,
            dl,
        );
        let status = outdated.status().await.unwrap();
        assert_eq!(status.state, "outdated");
        assert_eq!(status.installed_version.as_deref(), Some("0.9.0"));
    }

    #[tokio::test]
    async fn install_downloads_verifies_and_calls_the_cli_with_force() {
        let (ext, dl, rel) = fixture();
        let asset = vsix_asset_name("1.1.0");
        let payload = b"fake vsix bytes";
        let sha = hex::encode(sha2::Sha256::digest(payload));
        std::fs::write(rel.join(&asset), payload).unwrap();
        std::fs::write(
            rel.join(format!("{asset}.sha256")),
            format!("{sha}  {asset}\n"),
        )
        .unwrap();
        let release = FakeRelease::serve(rel.clone(), &asset);

        let log = dl.join("cli-args.txt");
        let cli = fake_cli(
            &dl,
            &format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n", log.display()),
            &format!(
                "@echo off\r\n(\r\necho %~1\r\necho %~2\r\necho %~3\r\n) > \"{}\"\r\n",
                log.display()
            ),
        );
        write_manifest(&ext, "cursor-byok.byok-workspace-symbols", "1.1.0");
        let wse = WorkspaceExtensions::new(
            "1.1.0".into(),
            release.base_url.clone(),
            ext,
            CursorCli::Fixed(cli),
            dl,
        );
        let status = wse.install().await.unwrap();
        assert_eq!(status.state, "current");
        let args = std::fs::read_to_string(&log).unwrap();
        let mut lines = args.lines();
        assert_eq!(lines.next(), Some("--install-extension"));
        let path = lines.next().unwrap();
        assert!(path.ends_with(&asset), "install path: {path}");
        assert_eq!(lines.next(), Some("--force"));
        assert_eq!(lines.next(), None);
    }

    #[tokio::test]
    async fn install_rejects_a_sha256_mismatch() {
        let (ext, dl, rel) = fixture();
        let asset = vsix_asset_name("1.1.0");
        std::fs::write(rel.join(&asset), b"payload").unwrap();
        std::fs::write(
            rel.join(format!("{asset}.sha256")),
            format!("{}  {asset}", "0".repeat(64)),
        )
        .unwrap();
        let release = FakeRelease::serve(rel.clone(), &asset);
        let cli = fake_cli(&dl, "#!/bin/sh\nexit 0\n", "@echo off\r\nexit /b 0\r\n");
        let wse = WorkspaceExtensions::new(
            "1.1.0".into(),
            release.base_url.clone(),
            ext,
            CursorCli::Fixed(cli),
            dl,
        );
        let error = wse.install().await.unwrap_err().to_string();
        assert!(error.contains("sha256 mismatch"), "{error}");
    }

    #[tokio::test]
    async fn install_reports_an_http_error() {
        let (ext, dl, rel) = fixture();
        let release = FakeRelease::serve(rel, "nothing-here");
        let cli = fake_cli(&dl, "#!/bin/sh\nexit 0\n", "@echo off\r\nexit /b 0\r\n");
        let wse = WorkspaceExtensions::new(
            "1.1.0".into(),
            release.base_url.clone(),
            ext,
            CursorCli::Fixed(cli),
            dl,
        );
        let error = wse.install().await.unwrap_err().to_string();
        assert!(error.contains("404"), "{error}");
    }

    #[tokio::test]
    async fn install_requires_the_cursor_cli() {
        let (ext, dl, _) = fixture();
        let wse = WorkspaceExtensions::new(
            "1.1.0".into(),
            "http://unused".into(),
            ext,
            CursorCli::Unavailable,
            dl,
        );
        let error = wse.install().await.unwrap_err().to_string();
        assert!(error.contains("Cursor CLI"), "{error}");
    }

    #[tokio::test]
    async fn install_surfaces_cli_stderr() {
        let (ext, dl, rel) = fixture();
        let asset = vsix_asset_name("1.1.0");
        let payload = b"vsix";
        let sha = hex::encode(sha2::Sha256::digest(payload));
        std::fs::write(rel.join(&asset), payload).unwrap();
        std::fs::write(
            rel.join(format!("{asset}.sha256")),
            format!("{sha}  {asset}"),
        )
        .unwrap();
        let release = FakeRelease::serve(rel.clone(), &asset);
        let cli = fake_cli(
            &dl,
            "#!/bin/sh\necho 'extension host refused' >&2\nexit 2\n",
            "@echo off\r\necho extension host refused 1>&2\r\nexit /b 2\r\n",
        );
        let wse = WorkspaceExtensions::new(
            "1.1.0".into(),
            release.base_url.clone(),
            ext,
            CursorCli::Fixed(cli),
            dl,
        );
        let error = wse.install().await.unwrap_err().to_string();
        assert!(error.contains("extension host refused"), "{error}");
        assert!(error.contains("--install-extension failed"), "{error}");
    }

    #[tokio::test]
    async fn save_vsix_writes_the_downloads_dir() {
        let (ext, dl, rel) = fixture();
        let asset = vsix_asset_name("1.1.0");
        let payload = b"vsix-bytes";
        let sha = hex::encode(sha2::Sha256::digest(payload));
        std::fs::write(rel.join(&asset), payload).unwrap();
        std::fs::write(
            rel.join(format!("{asset}.sha256")),
            format!("{sha}  {asset}"),
        )
        .unwrap();
        let release = FakeRelease::serve(rel.clone(), &asset);
        let wse = WorkspaceExtensions::new(
            "1.1.0".into(),
            release.base_url.clone(),
            ext,
            CursorCli::Unavailable,
            dl.clone(),
        );
        let saved = wse.save_vsix().await.unwrap();
        assert_eq!(saved, dl.join(&asset));
        assert_eq!(std::fs::read(&saved).unwrap(), payload);
    }

    #[test]
    fn sha256_lines_parse_the_hex_token() {
        let sha = "a".repeat(64);
        assert_eq!(
            parse_sha256(format!("{sha}  name\n").as_bytes()).as_deref(),
            Some(sha.as_str())
        );
        assert_eq!(parse_sha256(b"garbage"), None);
    }
}
