# quest/ : WORLD headset client

WebXR `immersive-ar` page (three.js + Vite) served from the laptop. It streams
camera frames + mic audio to the world service over `/ws/quest` and renders the
three HUD states from `CLAUDE.md` in passthrough. Same page runs in a desktop
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
| WebXR Raw Camera Access (`camera-access` feature, frame-aligned textures) | **Not in Quest Browser.** Meta said "WebXR support launching with v77" in the PCA launch post, but a Feb 2026 forum thread still asks for it. Do not rely on it. |
| `getUserMedia` video in Quest Browser | Reported working: enumerateDevices exposes the passthrough cameras (left/right) plus the avatar/front camera; frames come through as a normal MediaStream (Reactylon docs, forum reports). No intrinsics, no per-eye alignment. **Unverified on matt's 3S** and unverified whether frames keep flowing while an immersive session is running. The client is built to survive that (MediaStreamTrackProcessor pump + timer, not rAF). |
| scrcpy / casting | Mirrors the rendered headset view to the laptop. Great for showing the audience, bad as a CV input (composited, lens-warped). Installed (`scrcpy`), use it for the demo screen. |

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
src/panels.js         canvas rasterizer for the 3 panels (shared by both renderers)
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

Dev cockpit (`src/devpanels.js`): also receives `dev_github`, `dev_session` and
`context_delta`. GitHub panel sits left of the person, Claude Code panel right of
the card (body-locked in XR, not head-locked); `context_delta` lines fade in under
the card. `preview_shot` (screenshot of the Builder's branch, served
locally) pops in ~0.9 m in front of the wearer, world-locked; pinch scrolls, pinch-hold
closes, OPEN = open preview. Pinching APPROVE / OPEN PREVIEW / COMMENT sends `dev_action`. Hooks in
the other files are one-liners (grep `devpanels`); `?mock=1` plays it too.

## Run it (desktop, no headset)

```bash
cd quest
npm install
npm run dev                         # https://localhost:5173, proxies /ws -> localhost:8787
# no world service yet? stand-in:
npm run mock                        # listens on :8787, replays the demo HUD script
```

Open https://localhost:5173 (accept the self-signed cert), click **Desktop**.
`?mock=1` plays the demo HUD sequence client-side with no server at all.
Click a card or a person box = pinch.
`?emulate=1` installs Meta's IWER (emulated Quest 3 WebXR runtime) so **2. Enter AR**
works on the laptop: exercises the XR renderer, anchoring and status strip
(verified: panels render, frames keep streaming at 5 fps during the XR session).

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

1. Tap **1. Camera + mic**. Allow camera and microphone. The panel shows the
   camera label and `cam 5.0fps`. If the list has several cameras, pick the
   passthrough one (not "front"/avatar) in the dropdown.
2. Tap **2. Enter AR**. You should see passthrough plus a small status strip at
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

## Known gaps / verify on device

- Whether `getUserMedia` returns the passthrough camera on this 3S build, and
  whether frames keep flowing during `immersive-ar`. The in-headset status strip
  answers both in 10 seconds.
- XR anchoring assumes the camera looks where the head looks; tune `?hfov=` until
  the card sits beside the person. No depth, fixed distance (`?dist=`).
- Pinch relies on Quest hand tracking emitting `select`; controllers' trigger
  also works.
