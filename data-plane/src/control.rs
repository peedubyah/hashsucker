// Slice 3 — control-plane fetch + parse.
//
// Rust owns MOTION, not TRUTH. It fetches the authoritative TorrentFile + the
// Node-supplied, ordered provider coordinates from the Node control daemon and
// turns those coordinates into live runtime DeliveryCapabilities. It NEVER reads
// SQLite, never discovers/ranks, never substitutes a TorrentFile, never mutates
// identity. The control response IS the AcquireRequest source of truth.
//
// Wire schema version (POST-SLICE-2 hardening): every control message carries
// `schemaVersion`. We reject unsupported/missing versions rather than guess.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlTorrentFile {
    pub id: String,
    pub info_hash: String,
    pub canonical_internal_path: Option<String>,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCoord {
    pub provider: String,
    pub account_scope: String,
    pub provider_resource_id: String,
    pub provider_file_id: String,
    pub state: String,
    pub canonical_internal_path: Option<String>,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResponse {
    pub schema_version: u64,
    pub torrent_file: ControlTorrentFile,
    pub providers: Vec<ProviderCoord>,
}

impl ControlResponse {
    /// Select the provider-file coordinate whose size matches the authoritative
    /// TorrentFile size. This is NOT discovery: Node already handed us the
    /// (placement, fileId, size) mapping; we only pick the entry for the file we
    /// were told to serve. Returns None when no coord matches (should not happen
    /// for a well-formed control response).
    pub fn target_file_id(&self) -> Option<String> {
        self.providers
            .iter()
            .find(|p| p.size == self.torrent_file.size)
            .map(|p| p.provider_file_id.clone())
    }
}

/// Fetch + validate the control response. Rejects unsupported/missing
/// schemaVersion (exit-worthy on startup) and 404 NOT_FOUND.
pub async fn fetch_control(
    client: &reqwest::Client,
    control_url: &str,
    tf_id: &str,
    supported_schema: u64,
) -> Result<ControlResponse, String> {
    let url = format!("{control_url}/data-plane/files/{tf_id}");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("control fetch failed: {e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("control 404 NOT_FOUND (torrent file unknown to Node)".into());
    }
    let j: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("control json parse: {e}"))?;

    let recv = j
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if recv != supported_schema {
        return Err(format!(
            "UNSUPPORTED_SCHEMA_VERSION supported={supported_schema} received={recv}"
        ));
    }

    let cr: ControlResponse =
        serde_json::from_value(j).map_err(|e| format!("control structure parse: {e}"))?;
    if cr.providers.is_empty() {
        return Err("control returned zero provider coordinates (nothing to acquire)".into());
    }
    Ok(cr)
}
