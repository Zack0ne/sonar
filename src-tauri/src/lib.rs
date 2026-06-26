use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;
use tokio::time::timeout;

/// Result for a single scanned host. Mirrors the columns of the UI table.
#[derive(Debug, Clone, Serialize)]
struct HostResult {
    ip: String,
    /// "dead" | "alive" (ping/port reply but no open ports) | "ports" (open ports found)
    state: String,
    /// Round-trip time in milliseconds, kept to one decimal (LAN replies are sub-ms).
    ping_ms: Option<f64>,
    hostname: Option<String>,
    open_ports: Vec<u16>,
    web: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Progress {
    done: u64,
    total: u64,
}

#[derive(Debug, Deserialize)]
struct ScanOptions {
    start: String,
    end: String,
    ports: Vec<u16>,
    #[serde(default = "default_threads")]
    threads: usize,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
}

fn default_threads() -> usize {
    100
}
fn default_timeout() -> u64 {
    1000
}

/// Shared cancellation flag so the frontend can stop an in-flight scan.
#[derive(Default)]
struct ScanState {
    cancel: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
}

fn ipv4_to_u32(ip: Ipv4Addr) -> u32 {
    u32::from(ip)
}

fn u32_to_ipv4(n: u32) -> Ipv4Addr {
    Ipv4Addr::from(n)
}

/// ICMP-style reachability via the system `ping` binary (works without root on
/// macOS/Linux/Windows). Returns round-trip time in ms when a reply is seen.
async fn ping_host(ip: Ipv4Addr, timeout_ms: u64) -> Option<f64> {
    let ip_s = ip.to_string();

    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("ping");
        c.args(["-n", "1", "-w", &timeout_ms.to_string(), &ip_s]);
        c
    };

    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("ping");
        // -W is per-packet wait in milliseconds on macOS.
        c.args(["-c", "1", "-W", &timeout_ms.to_string(), &ip_s]);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let secs = ((timeout_ms as f64) / 1000.0).ceil().max(1.0) as u64;
        let mut c = tokio::process::Command::new("ping");
        // -W is per-reply timeout in seconds on Linux.
        c.args(["-c", "1", "-W", &secs.to_string(), &ip_s]);
        c
    };

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());

    let out = timeout(Duration::from_millis(timeout_ms + 500), cmd.output())
        .await
        .ok()?
        .ok()?;

    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    // Parse "time=12.3 ms" / "time=12ms" / "time<1ms". Keep one decimal so
    // sub-millisecond LAN replies (e.g. 0.123 ms) stay visible instead of
    // rounding down to 0.
    for token in text.split_whitespace() {
        if let Some(rest) = token.strip_prefix("time=") {
            let num: String = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            if let Ok(v) = num.parse::<f64>() {
                return Some((v * 10.0).round() / 10.0);
            }
        }
        if token.starts_with("time<") {
            // e.g. Windows "time<1ms": reply seen, but no measurable value.
            return Some(0.0);
        }
    }
    // Reply succeeded but no parsable time field — host is alive, timing unknown.
    Some(0.0)
}

/// Attempt a TCP connect to `port`. Returns true when the port accepts.
async fn check_port(ip: Ipv4Addr, port: u16, timeout_ms: u64) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    matches!(
        timeout(Duration::from_millis(timeout_ms), TcpStream::connect(addr)).await,
        Ok(Ok(_))
    )
}

/// Grab an HTTP `Server:` banner from a plaintext web port (80/8080/etc).
async fn web_detect(ip: Ipv4Addr, port: u16, timeout_ms: u64) -> Option<String> {
    let addr = SocketAddr::new(IpAddr::V4(ip), port);
    let mut stream = timeout(Duration::from_millis(timeout_ms), TcpStream::connect(addr))
        .await
        .ok()?
        .ok()?;

    let req = format!(
        "HEAD / HTTP/1.0\r\nHost: {}\r\nUser-Agent: ip-scanner\r\nConnection: close\r\n\r\n",
        ip
    );
    timeout(
        Duration::from_millis(timeout_ms),
        stream.write_all(req.as_bytes()),
    )
    .await
    .ok()?
    .ok()?;

    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    loop {
        match timeout(Duration::from_millis(timeout_ms), stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Err(_) => break,
            Ok(Ok(n)) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 8192 {
                    break;
                }
            }
            Ok(Err(_)) => break,
        }
    }

    let text = String::from_utf8_lossy(&buf);
    for line in text.lines() {
        if let Some(rest) = line.to_ascii_lowercase().strip_prefix("server:") {
            let val = line[line.len() - rest.len()..].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

/// Reverse DNS lookup (PTR). Returns None when unresolved.
async fn resolve_hostname(ip: Ipv4Addr) -> Option<String> {
    let ip = IpAddr::V4(ip);
    tokio::task::spawn_blocking(move || dns_lookup::lookup_addr(&ip).ok())
        .await
        .ok()
        .flatten()
        .filter(|h| !h.is_empty() && h != &ip.to_string())
}

async fn scan_one(ip: Ipv4Addr, ports: Arc<Vec<u16>>, timeout_ms: u64) -> HostResult {
    let ping_ms = ping_host(ip, timeout_ms).await;

    // Probe all requested ports concurrently.
    let futs = ports
        .iter()
        .map(|&p| async move { (p, check_port(ip, p, timeout_ms).await) });
    let mut open_ports: Vec<u16> = futures::future::join_all(futs)
        .await
        .into_iter()
        .filter_map(|(p, ok)| if ok { Some(p) } else { None })
        .collect();
    open_ports.sort_unstable();

    let alive = ping_ms.is_some() || !open_ports.is_empty();

    let mut hostname = None;
    let mut web = None;
    if alive {
        hostname = resolve_hostname(ip).await;

        // Try a web banner on the first plaintext HTTP port that is open.
        for &wp in &[80u16, 8080, 8000, 8888] {
            if open_ports.contains(&wp) {
                if let Some(server) = web_detect(ip, wp, timeout_ms).await {
                    web = Some(server);
                    break;
                }
            }
        }
    }

    let state = if !open_ports.is_empty() {
        "ports"
    } else if alive {
        "alive"
    } else {
        "dead"
    }
    .to_string();

    HostResult {
        ip: ip.to_string(),
        state,
        ping_ms,
        hostname,
        open_ports,
        web,
    }
}

#[tauri::command]
async fn scan(app: AppHandle, state: State<'_, ScanState>, options: ScanOptions) -> Result<(), String> {
    let start: Ipv4Addr = options
        .start
        .trim()
        .parse()
        .map_err(|_| format!("Invalid start IP: {}", options.start))?;
    let end: Ipv4Addr = options
        .end
        .trim()
        .parse()
        .map_err(|_| format!("Invalid end IP: {}", options.end))?;

    let start_n = ipv4_to_u32(start);
    let end_n = ipv4_to_u32(end);
    if end_n < start_n {
        return Err("End IP must be >= Start IP".into());
    }

    let total = (end_n - start_n) as u64 + 1;
    if total > 65_536 {
        return Err(format!("Range too large ({total} hosts). Max 65536."));
    }

    let cancel = state.cancel.clone();
    let running = state.running.clone();
    cancel.store(false, Ordering::SeqCst);
    running.store(true, Ordering::SeqCst);

    let ports = Arc::new(options.ports.clone());
    let timeout_ms = options.timeout_ms.max(100);
    let threads = options.threads.clamp(1, 1000);
    let sem = Arc::new(Semaphore::new(threads));
    let done = Arc::new(AtomicU64::new(0));

    app.emit("scan-started", Progress { done: 0, total }).ok();

    let mut handles = Vec::new();
    for n in start_n..=end_n {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        let permit = sem.clone().acquire_owned().await.unwrap();
        let app = app.clone();
        let ports = ports.clone();
        let done = done.clone();
        let cancel = cancel.clone();

        handles.push(tokio::spawn(async move {
            let _permit = permit;
            if cancel.load(Ordering::SeqCst) {
                return;
            }
            let ip = u32_to_ipv4(n);
            let result = scan_one(ip, ports, timeout_ms).await;
            let d = done.fetch_add(1, Ordering::SeqCst) + 1;
            app.emit("scan-result", &result).ok();
            app.emit("scan-progress", Progress { done: d, total }).ok();
        }));
    }

    for h in handles {
        let _ = h.await;
    }

    running.store(false, Ordering::SeqCst);
    let cancelled = cancel.load(Ordering::SeqCst);
    app.emit(
        "scan-finished",
        serde_json::json!({ "cancelled": cancelled, "total": total }),
    )
    .ok();

    Ok(())
}

#[tauri::command]
fn cancel_scan(state: State<'_, ScanState>) {
    state.cancel.store(true, Ordering::SeqCst);
}

/// Best-effort primary local IPv4 of this machine. Uses the "connect a UDP
/// socket to a public address" trick — no packets are actually sent; the OS
/// just picks the source IP of the default route. Returns None when offline.
#[tauri::command]
fn local_ipv4() -> Option<String> {
    use std::net::UdpSocket;
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) if !v4.is_loopback() => Some(v4.to_string()),
        _ => None,
    }
}

/// Show a native "Save As" dialog and write `content` to the chosen path.
/// Returns the saved path, or None if the user cancelled.
#[tauri::command]
async fn export_results(
    app: AppHandle,
    default_name: String,
    content: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file();

    match file {
        Some(fp) => {
            let path = fp.into_path().map_err(|e| e.to_string())?;
            std::fs::write(&path, content).map_err(|e| e.to_string())?;
            Ok(Some(path.display().to_string()))
        }
        None => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanState::default())
        .invoke_handler(tauri::generate_handler![
            scan,
            cancel_scan,
            local_ipv4,
            export_results
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
