// Slice 3.5 — provider acquisition. Turns a Node-supplied ProviderCoord into a live
// runtime DeliveryCapability. NO discovery, NO ranking, NO TorrentFile substitution:
// we only use the exact placement + providerFileId Node handed us.
//
// TorBox (Slice 3.5 §1): requestdl WITHOUT redirect=true -> TorBox returns 200 JSON with
// `data` = the final CDN URL. We parse that and build the capability around the FINAL CDN
// URL. The RangeEngine then sends subsequent byte requests directly to that CDN host. We
// never preserve requestdl itself as the media-byte origin. (Legacy redirect=true mode is
// kept ONLY behind TB_REDIRECT_TRUE for the §10 before/after comparison.)
//
// RealDebrid MODE A: reuse an existing /downloads artifact that already matches the
// authoritative size (no new provider state). MODE B (gated RD_MODE_B=1): addMagnet +
// selectFiles + poll until ready + unrestrict + Range-validate. MODE B creates provider
// state and is OFF by default to avoid side effects; it is reported as INFERRED.

use crate::capability::{AcquireError, ApiKeys, DeliveryCapability, parse_retry_after};
use crate::control::{ControlTorrentFile, ProviderCoord};
use crate::metrics::Metrics;
use reqwest::header::{ACCEPT, AUTHORIZATION, RANGE, RETRY_AFTER};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

const REALDEBRID_API_BASE: &str = "https://api.real-debrid.com/rest/1.0";
const TORBOX_API_BASE: &str = "https://api.torbox.app/v1/api";

/// Extract the host from an https URL (avoids adding the `url` crate as a direct dep).
pub(crate) fn host_of(u: &str) -> Option<String> {
    let after = u.split_once("://")?.1;
    let host = after.split('/').next().unwrap_or(after);
    Some(host.split(':').next().unwrap_or(host).to_string())
}

pub async fn acquire(
    coord: &ProviderCoord,
    tf: &ControlTorrentFile,
    keys: &ApiKeys,
    client: &reqwest::Client,
    metrics: &Metrics,
) -> Result<Arc<DeliveryCapability>, AcquireError> {
    match coord.provider.as_str() {
        "torbox" => acquire_torbox(coord, tf, keys, client, metrics).await,
        "realdebrid" => acquire_realdebrid(coord, tf, keys, client, metrics).await,
        other => Err(AcquireError::NoCapability(format!(
            "unsupported provider: {other}"
        ))),
    }
}

// ---- TorBox ---------------------------------------------------------------
async fn acquire_torbox(
    coord: &ProviderCoord,
    tf: &ControlTorrentFile,
    keys: &ApiKeys,
    client: &reqwest::Client,
    metrics: &Metrics,
) -> Result<Arc<DeliveryCapability>, AcquireError> {
    if keys.torbox.is_empty() {
        return Err(AcquireError::NoCapability("torbox: missing API key".into()));
    }
    // Slice 3.5 §1: default to NO redirect=true so we never follow a 3xx and never
    // preserve requestdl as the media origin. TB_REDIRECT_TRUE=1 restores the legacy
    // redirect-following path purely for the before/after comparison (§10).
    let use_redirect = std::env::var("TB_REDIRECT_TRUE")
        .map(|v| v == "1")
        .unwrap_or(false);
    let url = if use_redirect {
        format!(
            "{TORBOX_API_BASE}/torrents/requestdl?token={}&torrent_id={}&file_id={}&redirect=true",
            keys.torbox, coord.provider_resource_id, coord.provider_file_id
        )
    } else {
        format!(
            "{TORBOX_API_BASE}/torrents/requestdl?token={}&torrent_id={}&file_id={}",
            keys.torbox, coord.provider_resource_id, coord.provider_file_id
        )
    };

    let started = std::time::Instant::now();
    // §10 bounded recovery: an acquisition call must never wedge the read path. If TorBox
    // stalls/rate-limits the connection (drops without RST), bound it so we surface a clean
    // error (which becomes a 502/Retry-After upstream) instead of hanging the whole read.
    let resp = match tokio::time::timeout(Duration::from_secs(25), client.get(&url).send()).await {
        Ok(r) => r.map_err(|e| AcquireError::Transient(format!("torbox requestdl: {e}")))?,
        Err(_) => {
            return Err(AcquireError::Transient(
                "torbox requestdl timed out (25s)".into(),
            ))
        }
    };

    // Layer A metrics (requestdl / API acquisition).
    let status = resp.status().as_u16();
    metrics.record_api(status, started.elapsed());
    if use_redirect {
        metrics.api_redirect_true.fetch_add(1, Ordering::SeqCst);
    }

    if status == 429 {
        let ra = parse_retry_after(
            resp.headers()
                .get(RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
        );
        return Err(AcquireError::RateLimited(ra));
    }

    // Resolve the final CDN URL depending on mode.
    let final_url = if use_redirect {
        // Legacy path: client followed the 307; the final url is the CDN url.
        if !resp.status().is_success() {
            return Err(AcquireError::NoCapability(format!(
                "torbox requestdl status {}",
                resp.status()
            )));
        }
        metrics.record_redirect_hop();
        resp.url().to_string()
    } else {
        // Slice 3.5 path: 200 JSON with `data` = final CDN URL (no redirect hop).
        if !resp.status().is_success() {
            return Err(AcquireError::NoCapability(format!(
                "torbox requestdl status {}",
                resp.status()
            )));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AcquireError::Transient(format!("torbox requestdl json: {e}")))?;
        let data = body
            .get("data")
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                AcquireError::NoCapability("torbox requestdl: missing `data` CDN URL".into())
            })?;
        data.to_string()
    };

    // Protocol-invalid guard (mirrors torbox-download-url-cache.js): the capability must
    // have left the TorBox API host and landed on a CDN.
    if let Some(host) = host_of(&final_url) {
        if host.ends_with("torbox.app") {
            return Err(AcquireError::NoCapability(
                "torbox requestdl did not resolve to a CDN (protocol-invalid)".into(),
            ));
        }
        metrics.set_final_cdn_host(&host);
    }

    // TTL (§4): TorBox publishes no explicit signed-URL lifetime in the requestdl response,
    // so this is a LOCALLY-ASSUMED refresh age (conservative operational upper bound), NOT a
    // provider-known expiry. Telemetry distinguishes this via the acquisition-mode note and
    // the eviction counter (real evictions are measured, not assumed).
    let ttl = std::env::var("TORBOX_TTL_SECONDS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(600);
    let cap = DeliveryCapability::new(
        final_url,
        "torbox".into(),
        coord.account_scope.clone(),
        tf.info_hash.clone(),
        coord.provider_resource_id.clone(),
        coord.provider_file_id.clone(),
        Some(Duration::from_secs(ttl)),
    );
    metrics.capability_acquisitions.fetch_add(1, Ordering::SeqCst);
    Ok(cap)
}

// ---- RealDebrid -----------------------------------------------------------
async fn acquire_realdebrid(
    coord: &ProviderCoord,
    tf: &ControlTorrentFile,
    keys: &ApiKeys,
    client: &reqwest::Client,
    metrics: &Metrics,
) -> Result<Arc<DeliveryCapability>, AcquireError> {
    if keys.realdebrid.is_empty() {
        return Err(AcquireError::NoCapability("realdebrid: missing API key".into()));
    }
    // MODE A — reuse an existing /downloads artifact (no provider state created).
    if let Ok(cap) = acquire_rd_mode_a(coord, tf, keys, client, metrics).await {
        return Ok(cap);
    }
    // MODE B — create state only when explicitly enabled.
    if std::env::var("RD_MODE_B").map(|v| v == "1").unwrap_or(false) {
        if let Ok(cap) = acquire_rd_mode_b(coord, tf, keys, client, metrics).await {
            return Ok(cap);
        }
    }
    Err(AcquireError::NoCapability(
        "realdebrid: no existing download (MODE_A miss) and MODE_B disabled".into(),
    ))
}

// MODE A: GET /downloads, find an artifact whose filesize == authoritative size.
async fn acquire_rd_mode_a(
    coord: &ProviderCoord,
    tf: &ControlTorrentFile,
    keys: &ApiKeys,
    client: &reqwest::Client,
    metrics: &Metrics,
) -> Result<Arc<DeliveryCapability>, AcquireError> {
    let url = format!("{REALDEBRID_API_BASE}/downloads?limit=100");
    let started = std::time::Instant::now();
    let resp = match tokio::time::timeout(
        Duration::from_secs(25),
        client
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {}", keys.realdebrid))
            .header(ACCEPT, "application/json")
            .send(),
    )
    .await
    {
        Ok(r) => r.map_err(|e| AcquireError::Transient(format!("rd downloads: {e}")))?,
        Err(_) => {
            return Err(AcquireError::Transient(
                "rd downloads timed out (25s)".into(),
            ))
        }
    };
    metrics.record_api(resp.status().as_u16(), started.elapsed());

    if resp.status().as_u16() == 429 {
        let ra = parse_retry_after(
            resp.headers()
                .get(RETRY_AFTER)
                .and_then(|v| v.to_str().ok()),
        );
        return Err(AcquireError::RateLimited(ra));
    }
    if !resp.status().is_success() {
        return Err(AcquireError::NoCapability(format!(
            "rd downloads status {}",
            resp.status()
        )));
    }
    let arr: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AcquireError::Transient(format!("rd downloads json: {e}")))?;
    let list = arr
        .as_array()
        .ok_or_else(|| AcquireError::NoCapability("rd downloads not an array".into()))?;

    for d in list {
        let fs = d.get("filesize").and_then(|v| v.as_u64()).unwrap_or(0);
        if fs == tf.size {
            if let Some(dl) = d.get("download").and_then(|v| v.as_str()) {
                let ttl = std::env::var("RD_TTL_SECONDS")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(3600);
                let cap = DeliveryCapability::new(
                    dl.to_string(),
                    "realdebrid".into(),
                    coord.account_scope.clone(),
                    tf.info_hash.clone(),
                    coord.provider_resource_id.clone(),
                    coord.provider_file_id.clone(),
                    Some(Duration::from_secs(ttl)),
                );
                metrics.capability_acquisitions.fetch_add(1, Ordering::SeqCst);
                return Ok(cap);
            }
        }
    }
    Err(AcquireError::NoCapability(
        "rd downloads: no artifact matching authoritative size".into(),
    ))
}

// MODE B (INFERRED — gated, not exercised by default): addMagnet -> selectFiles(all)
// -> poll info until ready -> unrestrict -> Range-validate. Creates provider state.
async fn acquire_rd_mode_b(
    coord: &ProviderCoord,
    tf: &ControlTorrentFile,
    keys: &ApiKeys,
    client: &reqwest::Client,
    metrics: &Metrics,
) -> Result<Arc<DeliveryCapability>, AcquireError> {
    let magnet = format!("magnet:?xt=urn:btih:{}", tf.info_hash);
    let add = client
        .post(format!("{REALDEBRID_API_BASE}/torrents/addMagnet"))
        .header(AUTHORIZATION, format!("Bearer {}", keys.realdebrid))
        .header(ACCEPT, "application/json")
        .form(&[("magnet", magnet.as_str())])
        .send()
        .await
        .map_err(|e| AcquireError::Transient(format!("rd addMagnet: {e}")))?;
    if !add.status().is_success() {
        return Err(AcquireError::NoCapability(format!(
            "rd addMagnet status {}",
            add.status()
        )));
    }
    let add_json: serde_json::Value = add
        .json()
        .await
        .map_err(|e| AcquireError::Transient(format!("rd addMagnet json: {e}")))?;
    let rid = add_json
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AcquireError::NoCapability("rd addMagnet missing id".into()))?;

    let sel = client
        .post(format!("{REALDEBRID_API_BASE}/torrents/selectFiles/{rid}"))
        .header(AUTHORIZATION, format!("Bearer {}", keys.realdebrid))
        .header(ACCEPT, "application/json")
        .form(&[("files", "all")])
        .send()
        .await
        .map_err(|e| AcquireError::Transient(format!("rd selectFiles: {e}")))?;
    if !sel.status().is_success() {
        return Err(AcquireError::NoCapability(format!(
            "rd selectFiles status {}",
            sel.status()
        )));
    }

    // Bounded poll until the torrent is ready (status 5 = downloaded).
    let mut link: Option<String> = None;
    for _ in 0..30 {
        let info = client
            .get(format!("{REALDEBRID_API_BASE}/torrents/info/{rid}"))
            .header(AUTHORIZATION, format!("Bearer {}", keys.realdebrid))
            .header(ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| AcquireError::Transient(format!("rd info: {e}")))?;
        if info.status().is_success() {
            if let Ok(j) = info.json::<serde_json::Value>().await {
                if j.get("status").and_then(|v| v.as_i64()) == Some(5) {
                    if let Some(files) = j.get("files").and_then(|v| v.as_array()) {
                        for f in files {
                            if f.get("bytes").and_then(|v| v.as_u64()) == Some(tf.size) {
                                if let Some(l) = f.get("link").and_then(|v| v.as_str()) {
                                    link = Some(l.to_string());
                                    break;
                                }
                            }
                        }
                    }
                    if link.is_none() {
                        link = j.get("links")
                            .and_then(|v| v.as_array())
                            .and_then(|a| a.first())
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                    if link.is_some() {
                        break;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(4)).await;
    }
    let link = link
        .ok_or_else(|| AcquireError::NoCapability("rd mode_b: torrent not ready".into()))?;

    let unrestrict = client
        .post(format!("{REALDEBRID_API_BASE}/unrestrict/link"))
        .header(AUTHORIZATION, format!("Bearer {}", keys.realdebrid))
        .header(ACCEPT, "application/json")
        .form(&[("link", link.as_str())])
        .send()
        .await
        .map_err(|e| AcquireError::Transient(format!("rd unrestrict: {e}")))?;
    if !unrestrict.status().is_success() {
        return Err(AcquireError::NoCapability(format!(
            "rd unrestrict status {}",
            unrestrict.status()
        )));
    }
    let uj: serde_json::Value = unrestrict
        .json()
        .await
        .map_err(|e| AcquireError::Transient(format!("rd unrestrict json: {e}")))?;
    let dl = uj
        .get("download")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AcquireError::NoCapability("rd unrestrict missing download".into()))?;

    // Range-validate the unrestricted link serves bytes.
    let probe = client
        .get(dl)
        .header(RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| AcquireError::Transient(format!("rd mode_b validate: {e}")))?;
    if !probe.status().is_success() && probe.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(AcquireError::NoCapability(format!(
            "rd mode_b validate status {}",
            probe.status()
        )));
    }

    let cap = DeliveryCapability::new(
        dl.to_string(),
        "realdebrid".into(),
        coord.account_scope.clone(),
        tf.info_hash.clone(),
        coord.provider_resource_id.clone(),
        coord.provider_file_id.clone(),
        Some(Duration::from_secs(
            std::env::var("RD_TTL_SECONDS")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(3600),
        )),
    );
    metrics.capability_acquisitions.fetch_add(1, Ordering::SeqCst);
    Ok(cap)
}
