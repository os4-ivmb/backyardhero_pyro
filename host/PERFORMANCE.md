# Host performance and resilience fixes

Reviewed against the supplied `perf.md` audit and repository baseline `04615cd`.
The fixes preserve arming, manual-fire, radio STOP, pause, and show-start timing.
`monitor_switch` changes only add worker heartbeats, error throttling, and a sleep
that runs even after exceptions. `_run_show_body` changes only gate the firing-array
print behind debug mode. Daemon shutdown sends no radio STOP and leaves the show
marker derived from the current show state.

## Audit disposition

| Tasks | Result |
| --- | --- |
| T-01 | Already correct in this checkout: `_is_slow_command` is static; the referenced `_update_sequence_run_led` helper does not exist. Regression tests protect the actual command binding. |
| T-02 | Added isolated Python unit and process integration tests, development requirements, and pre-image Python checks in CI. |
| T-03–05 | Per-file command isolation and success/failure acknowledgments; startup purge and five-second age limit with stop/abort exceptions; switch error throttling and guaranteed sleep. An acknowledgment for a slow command means queued, as before. |
| T-06–08 | Bridge restart loops on Pi/dev/mac launchers; persistent supervisor retries, process-group shutdown, health checks covering HTTP/WS/state freshness; bounded bridge connect/send and serialized setup. |
| T-09–11 | Filtered state and runtime-directory watchers, stale-file rejection, larger Unix send buffers, rate-limited oversize fallback, and loopback UDP on Windows or when Unix sockets are unavailable. Windows may expose AF_UNIX without supporting Unix datagrams, so it explicitly uses UDP. |
| T-12–14 | Debug-gated serial/firing-array prints; bounded Docker, daemon, and desktop logs; five import backups retained; WAL with opt-out and busy timeout; Python DB handles closed before cue upload. |
| T-15–16 | SIGTERM/SIGINT cleanup, final snapshot, bounded joins, per-worker monotonic heartbeats and diagnostics. Watchdog exits are deferred while show threads remain alive. |
| T-17 | 50 ms publish spacing, cached receiver config encoding/revision, and BLAKE2 signatures excluding timestamps/liveness/thread ages. |
| T-18 | Timing moved outside `stateData`, equal state subtrees retained, narrow subscriptions in the heavy panels and read-only Settings panels. Optimistic Settings editors retain full state when replacing it. Socket lifecycle code in desktop/mobile status bars is unchanged. |
| T-19 | Restarted state-pump tasks, client-count LED status, shorter WebSocket ping timeout; heartbeat liveness is recomputed when the daemon stops. |
| T-20 | Build-time ownership avoids the final `/app` chown layer; production npm pruning, six unused packages removed, direct Python dependencies pinned to the tested environment, downloader kept as a version floor. Single-stage build remains; image validation is blocked as described below. |
| T-21–22 | Atomic cursor/LED/activity writes, transient TX LED writes skipped, stale snapshot temp cleanup, bridge per-client stop event/reader join, idle backoff, and aggregated drop diagnostics. |
| T-23 | Show-list ETag/304 added. `runtime_payload` is retained because `ShowControl.saveSyncOffset` reads it from the listing; metadata-only responses remain a separately scoped follow-up. |
| T-24–25 | Audio ETag/Last-Modified revalidation preserves ranges; startup delay reduced to one second; monotonic dongle liveness, value-based LED comparison, and accurate socket device presence. |

## Validation

Run from the repository root, with host Python dependencies and npm dependencies installed:

```sh
python -m pip install -r host/pythings/requirements-dev.txt
python -m pyflakes host/pythings/pc_daemon host/pythings/websock_server host/tcp_serial_bridge
python -m pytest host/pythings/tests
npm --prefix host/byh_app/backyardhero test
NEXT_TELEMETRY_DISABLED=1 npm --prefix host/byh_app/backyardhero run build
python host/byh_app/backyardhero/tests/api-smoke.py
python host/pythings/benchmarks/state_publish.py --baseline 04615cd
```

Validation completed with 23 Python tests and three Node tests passing.

The Python suite covers command dispatch and queueing, malformed and stale command
files, stop/abort age exceptions, snapshot validity, oversize fallback throttling,
log rotation, atomic-file cleanup, publish pacing, watchdog deferral, switch error
throttling, send timeout recovery, stale-state rejection, UDP round trips, state
pump restart/cancellation, bridge idle backoff and disconnect cleanup, and the
three-process mock stack. The process test checks startup purge, failed-command
recovery, non-default runtime cursor updates, multi-client LED state, and clean
SIGTERM. It skips only when another WebSocket server owns port 8090.

The Node tests cover unchanged heartbeat identity, live receiver updates, and
in-process desktop log rotation. The HTTP smoke test passes show save/list and
304 responses, audio date/ETag validators and byte ranges, WAL activation, a
complete SQLite backup export/import, and five-backup retention. Production Next
build, Bash syntax, Compose configuration, and Python static checks pass.

### Measurements

Synthetic workload: 16 receiver records, four zones of 64 cues per receiver,
1,000 snapshot/encoding iterations, and one second of continuous dirty marks.
No radio, DB upload, browser profiling, or Pi CPU measurements are included.
The benchmark compares baseline source with the working tree in the same process
and excludes socket/disk delivery from snapshot serialization timing.

| Measurement | Baseline | Changed |
| --- | ---: | ---: |
| Daemon snapshot generation | 185.6 µs | 187.4 µs |
| WebSocket encode per new state version | 398.9 µs | 213.1 µs |
| Publishes/sec under continuous dirty marks | 92.5 | 20.9 |

WebSocket encoding is about 47% faster. Per-daemon-snapshot cost is approximately
unchanged; the publish cap reduces total serialization work. The short rate
measurement includes the initial immediate snapshot, hence approximately 21
publishes rather than exactly 20 in that window.

### Remaining validation

- Docker build attempted but failed in the existing apt installation step:
  the build environment's HTTPS proxy certificate issuer is not trusted inside
  the base image. No TLS verification bypass was added. Container startup,
  supervisor crash-loop recovery, arm64 build, dependency resolution in the
  final image, and before/after image size are unverified. Python pins were
  taken from the working Linux environment rather than a completed image.
- Native macOS datagram delivery/WAL and Windows desktop UDP/Proactor behavior
  need validation on those platforms. UDP fallback is exercised on Linux.
- Receiver OTA throughput and physical bridge recovery need hardware checks.
- React DevTools profiling and full browser tab/liveness interaction checks
  remain unverified; store reference preservation and production compilation
  have automated coverage.
- The optional standalone/multi-stage image and metadata-only show lists were
  deliberately left as separate follow-ups.
