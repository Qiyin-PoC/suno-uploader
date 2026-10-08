# Tauri feasibility preview

This is the current lightweight client for the Windows handoff; it remains a QA build, not a commercial release. See ../docs/WINDOWS-HANDOFF.md.
It reuses the existing Python upload/download/lyrics engine in a frozen standalone runtime, with a
small Rust host and a reduced interface using the existing studio's light green visual direction.

## Build

Requirements on the build machine: Node >=22.12, Rust, OS native build tools, and Python.
Recipients of a properly built bundle do not need Python or Node. Suno login still needs Chrome/Edge.
Build separately on every supported OS and architecture; the runtime must match the target.

From repository root:

```sh
npm ci
.venv/bin/python -m pip install -r backend/requirements.txt -r tauri-preview/requirements-build.txt
# First Intel Mac prototype: build FFmpeg (requires a static LAME library).
sh tauri-preview/build_ffmpeg_macos.sh
QIYIN_PREVIEW_FFMPEG=/tmp/qiyin-ffmpeg-build/ffmpeg-8.0.1/ffmpeg .venv/bin/python tauri-preview/build_runtime.py
QIYIN_LOCAL_PREVIEW=1 QIYIN_TAURI_LICENSE_URL=http://127.0.0.1:18870 .venv/bin/python tauri-preview/package_macos.py
```

Windows uses the virtual environment's `Scripts/python.exe`. Choose `--bundles nsis` on Windows
and `--bundles appimage` on Linux. Those platforms are not yet validated. The checked-in default
bundle targets are for the first Mac experiment only.

`QIYIN_LOCAL_PREVIEW=1` is a compile-time flag allowing **loopback HTTP only** for a local QA server.
Normal builds accept HTTPS only. The URL is compiled into the app so environment changes cannot
redirect an existing login token. Empty URL fails closed. Production sale is blocked pending real
service configuration, payment merchant setup, runtime license review, signing and OS acceptance.

The preview has its own bundle ID and application-data directory. It cannot read Electron's
account token. The preview keeps its commercial account token **only in Rust memory**, never in
the web page or local storage; restarting requires login. A server-authorized feature check runs
before every worker start. Suno credentials use the existing Python storage inside the private
preview data directory (still plaintext at rest; production migration to OS credential storage remains).

## Scope

- Login/register/status/logout against the existing account service.
- Native multi-audio/folder picker, sequential batch stable-mode upload, Suno browser login, downloads in three
  formats with a multi-link queue, six existing lyrics modes, read-only upload history.
- One active worker, process-group cancellation and termination on app close.
- Frozen Python dependencies and bundled FFmpeg; no fallback to a developer's Python or FFmpeg.
- Update button clearly reports an unconfigured service. The updater plugin is included, but
  signed download/install/restart/rollback has **not** been implemented or tested. No claim of
  working automatic updates.

Not yet migrated: durable batch queues/resume, multi-Suno account switching, commercial
device-management/payment UI, remembered login, OS signing, real update deployment.

The first candidate from imageio-ffmpeg was rejected because it had `--enable-nonfree` enabled.
The current runtime uses FFmpeg 8.0.1 compiled from official source with audio-only features and
static LAME, without GPL/nonfree options. The build script is included. Supply matching FFmpeg
and LAME source packages, notices, and all dependency licenses with the eventual distribution;
production distribution compliance has not yet been completed. The Python wrapper's license
is not a substitute for the FFmpeg binary's license. The runtime builder rejects nonfree builds.

See [validation and size report](../docs/TAURI-PREVIEW.md) for actual measured results and gaps.

The measured prototype requires macOS 26: both the current Homebrew Python framework and
the locally compiled FFmpeg have a macOS 26 minimum deployment target. Older macOS support
requires rebuilding/replacing those runtimes, followed by tests on those OS versions.

On mixed Rosetta/native build machines, `QIYIN_NODE` can select the Node executable that matches
the installed Tauri CLI native module. `package_macos.py` always labels the output using Rust
and validates it against the frozen Python architecture.
