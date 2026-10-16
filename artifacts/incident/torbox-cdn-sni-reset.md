# Incident: `nexus.erth.tb-cdn.earth` TLS reset — attributed to a local WAN SNI filter

UTC: 2026-10-16T19:41Z. Host egress: 192.168.1.2 via gateway 192.168.1.254
(Arris Telco CPE, AT&T; `search attlocal.net`). Public egress IP 104.58.146.255.
No secrets, tokens, or signed URLs are recorded here.

## Symptom

TorBox `requestdl` returns a signed CDN URL on host `nexus.erth.tb-cdn.earth`.
TCP connects, then TLS resets immediately after the ClientHello
(`write:errno=104` / `ECONNRESET`, ~35 ms, deterministic). No byte can be read.

## Evidence

1. **Single, universal edge.** 12/12 current cached TorrentFiles (distinct
   resources 95797857…120334360, files 0/1) returned the SAME host
   `nexus.erth.tb-cdn.earth`. `redirect=true` 307s to the same host. No other
   hostname appeared.

2. **Resolved IPs are Cloudflare.** `172.66.155.241`, `104.20.42.216`
   (IPv4); `2606:4700:10::…` (IPv6, `ENETUNREACH` here — no IPv6 route).

3. **Reset is SNI-exact and destination-independent** (the decisive test).
   Same IP `172.66.155.241`:

   | SNI | result |
   |---|---|
   | `nexus.erth.tb-cdn.earth` | ECONNRESET |
   | `nexus.erth.tb-cdn.earth.` (trailing dot) | ECONNRESET |
   | `api.torbox.app` | OK (CN=torbox.app) |
   | `erth.tb-cdn.earth` | OK |
   | `tb-cdn.earth` | OK |
   | `cloudflare.com` | OK (CN=cloudflare.com) |
   | `random.example.com` | OK (Cloudflare default cert) |

   And against NON-TorBox destinations, the SAME SNI resets while random SNIs
   on the same IP succeed:

   | destination IP | `nexus.erth.tb-cdn.earth` | random SNIs |
   |---|---|---|
   | 8.8.8.8 (Google DNS) | ECONNRESET | OK |
   | 1.1.1.1 (Cloudflare DNS) | ECONNRESET | OK |
   | 142.250.72.14 (Google) | ECONNRESET | OK |

   A reset keyed on one exact SNI, independent of the destination server, can
   only be a middlebox on the path — not TorBox, not Cloudflare's edge, and not
   the destination.

4. **Not the host/container.** Identical reset from the host (`openssl
   s_client`) and from the `media-search` container; no local filtering
   service, no proxy env, no SNI-capable nft rule.

5. **Not IPv4/IPv6.** IPv6 has no route; IPv4 resets.

6. **Not a client.** Node `tls`, `openssl`, and the Rust data-plane all reset
   identically.

## Attribution

A **SNI-based filter on the operator's WAN path** (AT&T gateway
`192.168.1.254` or AT&T network DPI) blocks the exact hostname
`nexus.erth.tb-cdn.earth`. It is not a TorBox/CDN fault.

## Narrow fix options (operator action; not applied here)

- Allowlist / unblock the hostname in the gateway's content/parental filter
  (Arris/AT&T BGW admin at `https://192.168.1.254/`), or disable the filter.
- Route that hostname through a trusted alternate egress the operator already
  controls (e.g. a Tailscale exit node on a peer on an unfiltered WAN). No exit
  node is currently advertised; no peer SSH access is available from this
  deployment, so this was not applied.

## Supported TorBox alternatives

None found. `requestdl` (JSON and `redirect=true`) is the only delivery
surface; it always returns `nexus.erth.tb-cdn.earth`. No API-host byte proxy
(`/torrents/download`, `/torrents/file` → 404). URL regeneration is
deterministic (same host). No supported workaround exists, so no unsafe one was
attempted (no TLS-verification bypass, no SNI spoofing, no signed-URL rewrite,
no DNS pinning, no third-party proxy).
