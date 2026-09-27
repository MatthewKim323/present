# quest/ : WORLD headset client

WebXR `immersive-ar` page (three.js + Vite) served from the laptop. It streams
camera frames + mic audio to the world service over `/ws/quest` and renders the
person context, memory, agent activity and 24 tool-driven panel types in passthrough. Same page runs in a desktop
browser over the webcam, so the HUD can be built without the headset.

## Decision

**Primary: WebXR in Quest Browser, camera via `getUserMedia`.**
**Fallback: another device is the "eye", Quest renders HUD only (`?video=0`).**

Why WebXR over Unity:

- Nothing native is installed here (no Unity Hub, no Android SDK). A Unity MR +
  Passthrough Camera API build is a multi-hour install + first-build tax before
  the first frame leaves the headset. WebXR is a URL: edit, reload, done.
- `immersive-ar` passthrough + transparent three.js layers is mature in Quest
  Browser. That covers the HUD fully.
- Mic is plain `getUserMedia({audio})`, works in Quest Browser.

What we know about camera access (as of Sept 2026):

| path | status |
|---|---|
| Native Passthrough Camera API (Android Camera2, Unity/Unreal/Spatial SDK) | Shipped. Quest 3 / 3S, Horizon OS v74+ (v76+ recommended), permission `horizonos.permission.HEADSET_CAMERA`, 1280x960 @ up to 60 Hz, 20-40 ms latency. Verified in Meta docs. |
| WebXR Raw Camera Access (`camera-access` feature, frame-aligned textures) | **Rejected on the tested Quest 3S browser build.** A required-feature session returned `NotSupportedError`; do not rely on this path until it passes a headset probe. |
| `getUserMedia` video in Quest Browser | Reported working: enumerateDevices exposes the passthrough cameras (left/right) plus the avatar/front camera; frames come through as a normal MediaStream (Reactylon docs, forum reports). No intrinsics, no per-eye alignment. **Unverified on matt's 3S** and unverified whether frames keep flowing while an immersive session is running. The client is built to survive that (MediaStreamTrackProcessor pump + timer, not rAF). |
| scrcpy / casting | Mirrors the rendered headset view to the laptop. Great for showing the audience, bad as a CV input (composited, lens-warped). Installed (`scrcpy`), use it for the demo screen. |

On the tested Quest 3S, plain `immersive-ar` succeeds but a session requiring
`camera-access` fails with `NotSupportedError`. The Quest renderer therefore
uses compositor-transparent glass with specular surface highlights. It keeps
the native 360-degree room visible without a misregistered camera copy. The
React Bits FluidGlass transmission shader remains available for rendered
scenes and for a future XR runtime that supplies view-aligned camera textures;
it cannot refract Quest Browser's compositor passthrough today.

If `getUserMedia` does not give the passthrough camera on the 3S, the fallback is
immediate: laptop webcam or a phone runs the desktop page (or `perception.sim`)
as the eye, and the headset loads `?video=0` (mic + HUD only). Cards then float
ahead-right instead of hugging the person, which still reads fine in a demo.

If we later need real camera-aligned anchoring and have hours to spare, the
upgrade is Unity + Meta's `PassthroughCameraApiSamples` (CameraToWorld sample),
speaking the same `/ws/quest` contract.

## Layout

```
index.html            control panel (camera picker, label box, log)
src/config.js         URL-param knobs (fps, width, hfov, mock, video, audio, ws)
src/link.js           /ws/quest client, auto-reconnect, drops frames on backpressure
src/capture.js        camera pick + JPEG frame grabber, mic -> 16 kHz PCM16 chunks
public/pcm16-worklet.js  AudioWorklet (ScriptProcessor fallback in capture.js)
src/hud.js            HUD state (cards, toasts, activity, track bboxes)
src/panels.js         canvas rasterizer for native XR panels
src/PanelLibrary.jsx  interactive 24-type library and browser glass cards
src/components/       adapted React Bits source and native specular shader
src/desktop.js        desktop renderer over the webcam
src/xr.js             immersive-ar renderer, pinch -> gesture
src/mock.js           scripted demo HUD sequence (?mock=1)
scripts/mock-world.mjs  stand-in world service for solo dev
```

## Protocol (per contracts/EVENTS.md)

Sends: `frame` (jpeg_b64, w, h, head_pose = [px,py,pz,qx,qy,qz,qw] from the XR
viewer pose, identity on desktop), `audio` (pcm16_b64 @ 16 kHz, 250 ms chunks),
`gesture` (pinch on a card or nearest tracked person), `label` (from the panel).

Receives: `person_card`, `memory_event`, `agent_activity`. For anchoring it also
reads the perception service's debug `tracks` stream (it connects to
`/ws/quest?debug=1`), a forwarded `person.encountered` WorldEvent, or an optional
`bbox` on `person_card` / `agent_activity`. Bboxes can be pixels (of the sent
frame) or normalized 0..1.

Dev cockpit (`src/devpanels.js`): also receives `dev_github`, `qm_swarm` and
`context_delta`. GitHub panel sits left of the person, QM SWARM panel (one lane per
worker, Builder lane expands into its last Claude Code tool calls, recalled/learned
footer; replaces `agent_activity` for the same hook) right of the card (body-locked in XR, not head-locked); `context_delta` lines fade in under
the card. `preview_shot` (screenshot of the Builder's branch, served
locally) pops in ~0.9 m in front of the wearer, world-locked; pinch scrolls, pinch-hold
closes, OPEN = open preview. Pinching APPROVE / OPEN PREVIEW / COMMENT sends `dev_action`. Hooks in
the other files are one-liners (grep `devpanels`); `?mock=1` plays it too.

Perception overlay (`src/visionfx.js`): `vision` (~5 Hz, only on `?debug=1`/`?vision=1`
sockets) draws corner-bracket reticles, the 5 YuNet landmarks, a scan line while
detecting/matching, a label chip (`UNKNOWN PERSON 03` -> `MATCHING 0.41` -> `MATTHEW 0.87`
with a lock-on + letter-decode), top enrolled candidates (left of the face, fade after
lock) and a 16-bar embedding barcode on each face. Learning (self-intro "I'm Matthew"
or a `label`): progress ring with one tick per sample + a filmstrip of `face_capture`
crops (shown, never stored), then a `FACE LEARNED · MATTHEW` toast (swallows the
service's duplicate `PERSON ENROLLED`). `relationship_vector` = radar above the person
card (desktop: under the card column when there's no headroom). XR: one unit plane per
face at `?dist=`, sized from the bbox and `?hfov=`, head-facing, under the cards.
`?mock=1` scripts it first (unknown -> intro -> learning -> recognized -> radar grows)
and starts the rest of the demo 6.5s later.

## Run it (desktop, no headset)

```bash
cd quest
npm install
npm run dev                         # https://localhost:5173, proxies /ws -> localhost:8787
# no world service yet? stand-in:
npm run mock                        # listens on :8787, replays the demo HUD script
```

Open https://localhost:5173 (accept the self-signed cert), click **step inside** for preview, or use setup to start camera + mic.
`?mock=1` plays the fictional encounter client-side without capture or a server.
`?studio=1` opens the 24-type glass panel library. See [interface and agent contract](../docs/INTERFACE.md) for source provenance, tool calls and rendering limitations.
Click a card or a person box = pinch.
`?emulate=1` installs Meta's IWER (emulated Quest 3 WebXR runtime) so **2. Enter AR**
works on the laptop: exercises the XR renderer, anchoring and status strip
(physical headset validation is still required for the new glass material).

Useful params: `?fps=5&w=640&q=0.7` (frame rate, width, jpeg quality),
`?hfov=80&dist=1.6` (XR anchoring), `?cam=left` (prefer a camera label),
`?video=0` / `?audio=0`, `?ws=wss://host/ws/quest`, `?source=phone`.

If the world service runs somewhere else: `WORLD_URL=http://host:8787 npm run dev`.

## Get it on the headset

### One time

1. **Horizon OS version**: Settings > General > About. Want **v76 or newer**
   (PCA baseline). Update Quest Browser too (Library > Updates).
2. **Developer mode**: needs a Meta developer org (free, developers.meta.com >
   create organization, verify account). Then Meta Horizon phone app > Devices >
   your 3S > Headset settings > Developer mode ON. Reboot the headset.
3. **USB**: plug the 3S into the laptop with a USB-C data cable. In the headset,
   accept "Allow USB debugging" (tick "always allow"). `adb devices` should list it.
   (`adb` + `scrcpy` are installed via Homebrew.)

### Every session (cable, recommended: no cert warnings)

```bash
cd quest
NO_HTTPS=1 npm run dev       # plain http, localhost counts as a secure context
npm run adb:reverse          # headset localhost:5173 and :8787 -> laptop
```

In Quest Browser open **http://localhost:5173**, then:

1. Open settings and tap **start camera + mic**. Allow camera and microphone. The panel shows the
   camera label and `cam 5.0fps`. If the list has several cameras, pick the
   passthrough one (not "front"/avatar) in the dropdown.
2. Tap **enter AR**. You should see passthrough plus a small status strip at
   the bottom (`cam .. fps · mic live · ws open`). Pinch = select.

If Quest Browser refuses the camera, check Settings > Privacy & safety > App
permissions (Camera / Headset cameras / Microphone) for Browser.

### Wireless (LAN, no cable)

`npm run dev` (https), open **https://<laptop LAN ip>:5173** on the headset,
accept the certificate warning once. The page talks to the world service through
the Vite proxy (same-origin `wss://`), so no second cert is needed. Laptop and
headset must be on the same Wi-Fi without client isolation (hackathon Wi-Fi
often isolates; use the cable or a phone hotspot).

### Show the audience

`scrcpy --crop 1832:1920:0:0 --max-fps 30` mirrors the left eye to the laptop
(crop numbers vary by device, drop `--crop` to see both eyes).

## Camera glass and hand pointers

Exit AR and reload after changes. AR preserves Quest's full surrounding
passthrough. Native panels use the original React Bits bar geometry with a
nearly clear surface and subtle edge reflections. Quest composites the room
after WebGL, so sampling a second camera for glass would create a shifted copy.
The React Bits FluidGlass transmission shader remains available for rendered
scenes and GPU fixtures, but real-room optical refraction is not available
through Quest Browser's WebXR passthrough.

Entering AR does not start the camera. In live mode, tap **start camera + mic**
before **enter AR** to feed perception; in studio/mock mode, AR needs no camera.
Hand/controller beams work independently of camera capture.

## Headset diagnostics and performance

- `?diag=1` shows browser capabilities, granted XR features, camera and mic labels, WebSocket status and RTT, GPU limits, and `/health` in the control panel.
- `?perf=1` shows frame timing, draw calls, and texture count in AR and desktop mode.
- `?lite=1` reduces expensive visual effects and XR framebuffer scale for a slower headset.
- `?hz=90` requests that frame rate if Quest Browser lists it as supported.
- The OFFLINE chip appears after a lost WORLD connection; the client reconnects with backoff and checks half-open sockets with pings.
- The XR renderer is shared across AR sessions and scene resources are released on exit.

For a desktop benchmark with emulated XR and a throttled CPU, run `node scripts/perf-bench.mjs` from `quest/`. The `--fuzz` option sends malformed HUD messages to check that one bad payload does not stop rendering.

## Known gaps / verify on device

- Whether `getUserMedia` returns the passthrough camera on this 3S build, and
  whether frames keep flowing during `immersive-ar`. The in-headset status strip
  answers both in 10 seconds.
- XR anchoring assumes the camera looks where the head looks; tune `?hfov=` until
  the card sits beside the person. No depth, fixed distance (`?dist=`).
- Pinch relies on Quest hand tracking emitting `select`; controllers' trigger
  also works.

## Backend service drawer

Open **service** in the header for health, enrolled people, build history/detail,
agent panel commands and action receipts. Diagnostic inputs remain collapsed.
All mutations require an explicit click; starting a build launches real work.
The project MCP adapter and complete route map are in `../docs/FRONTEND-API.md`.

### Passthrough and glass registration

Production XrHud passes no camera source to the transmission pass. This removes
the competing camera image, preserving the same compositor room inside and outside
panels. Historical camera-calibration and camera-room fixtures remain diagnostic
code; their zero-offset checks never established registration against passthrough.
