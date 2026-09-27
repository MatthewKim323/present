# WORLD spatial interface

## Design

Monochrome, translucent surfaces with restrained light at the edges. Each card carries one thought, up to four rows and two actions. The library contains 24 types: person, commitment, decision, feedback, insight, memory, agent, swarm, approval, draft, checklist, procedure, timer, metric, compare, meeting, reminder, navigation, object, bug, code, note, quote, status. At most three panels are visible simultaneously.

Open `?studio=1` for the interactive library or `?mock=1` for the fictional encounter. Neither captures camera/audio or connects to the service. “Connect agent” switches to the live panel service without enabling capture. Camera and microphone require the separate setup control.

## Actual React Bits source

Native AR now uses **FluidGlass**, replacing the specular-border and custom camera-glass material path:

- Official React Bits source: https://reactbits.dev/r/FluidGlass-JS-CSS
- Actual original `bar.glb`: `quest/public/fluidglass/bar.glb`, downloaded from https://reactbits.dev/assets/3d/bar.glb and resized into physical panel slabs.
- Actual Drei `MeshTransmissionMaterialImpl`, with its GLSL preserved byte-for-byte. Pinned upstream source, SHA256, license and the React Bits reference component live under `quest/src/components/vendor/fluid-glass/`.
- `fluid-glass-pass.js` translates FluidGlass's `useFBO` / portal render into the existing native Three renderer. It renders a separate scene buffer for each eye and binds the matching texture when drawing that eye. Text stays a sharp overlay.
- FluidGlass settings retain ior 1.15 and anisotropic blur .01, with thickness scaled to meter-sized panels and chromatic aberration zero for monochrome styling.
- A separate documented coverage adapter preserves transparent buffer regions. Upstream transmission discards texture alpha; without this adapter an empty AR scene would produce an opaque slab. RoomEnvironment supplies neutral reflection lighting, not a simulated camera background.

Camera feed: complete raw per-eye textures take priority. Otherwise the local getUserMedia camera automatically feeds FluidGlass through a per-eye projection pass (camera FOV, capture pose, and a 2m scene plane), rather than a stretched background. Enter AR starts this camera if absent; preview stays local. The mono path is approximate because browser camera calibration and scene depth are unavailable; `?glass=raw` disables it for diagnostics.

Browser cards still use React Bits GlassSurface (SVG/CSS displacement) and SpecularButton; they are not the native AR material. SpecularButton's fragment source is shared verbatim in its own source file, but that shader is no longer used by `xr.js`.

Each tracked hand/controller has a solid white beam and endpoint even when no panel is hit. Actionable controls brighten the reticle and receive precise hover brackets. Lost poses and disconnected sources remove their pointers.

The office preview is illustrative scenery from [Unsplash](https://images.unsplash.com/photo-1497366754035-f200968a6e72), not a camera feed.

## Agent contract

`contracts/PANELS.json` is the canonical `world_panel` function schema. `GET /tools` returns the descriptor; a tool executor sends its arguments to `POST /tools/world-panel`. Operations are `show`, `update`, and `dismiss`. Show requires a stable ID, type and title. Optional fields include minimal body, rows, actions, placement, tracked-person anchor and lifetime. The service validates arguments, limits active panels to three, expires them and replays active panels to reconnecting clients.

```bash
curl -X POST http://localhost:8787/tools/world-panel \
  -H 'Content-Type: application/json' \
  -d '{"op":"show","id":"followup","type":"approval","title":"Share the prototype?","actions":[{"id":"review","label":"Review"},{"id":"hold","label":"Hold"}],"ttl_ms":60000}'
```

Selections return via `panel_action`; the client receives a `panel_result` receipt. `GET /panel-actions?after=0` exposes the bounded action queue with a cursor. A selection records intent only: it does not send email or execute external work. Agents must consume selections and perform their own authorized workflow. `GET /panels` lists active surfaces. The project now includes a WORLD stdio MCP adapter in `.mcp.json`; registration in the separate QM runtime is still required. See `docs/FRONTEND-API.md`.

## Verification and device limits

Frontend state, WebSocket lifecycle, panel validation, camera freshness/per-eye routing, shader uniforms/disposal and native Three ray intersections have automated coverage. Backend tests cover validation, lifetime, replay and selection receipts. Browser QA checks actual glass/shader components, library controls and service integration. `quest/tests/fluid-glass-gpu.html` renders the actual FluidGlass bar and transmission shader against a synthetic scene, checking pixel changes without camera permissions. Stereo-routing tests check separate buffers, matching eye binding and restoration on capture failure.

Physical Quest validation remains required for stereo appearance, passthrough contrast, camera availability and hand tracking. Camera-relative anchoring remains approximate (fixed depth and field of view), not a spatial map.

### Quest lens registration correction

The connected Quest 3S exposes Camera2 intrinsics and lens poses through `adb shell dumpsys media.camera`. Browser camera 1 maps to native camera 50; camera 2 maps to 51. The local profile replaces the 80° centred-pinhole guess with measured focal lengths, principal points, centred stream crop, lens tilt and translation. Android optical axes are converted to Three camera axes. The gyro-reference transform is assumed head-relative; this and the 2m scene plane remain approximations. Do not reuse this unit profile as universal headset calibration. The transmission pass also explicitly updates XR world matrices before its offscreen render, preventing a previous-frame eye pose from being used.

### Native passthrough restored

The full-room camera replacement was reverted at the user's request because it
replaced surrounding passthrough with the camera's limited FOV. Production
FluidGlass now samples camera pixels only inside panels. `cameraRoom: true` is
an explicit synthetic-fixture option, never enabled by XrHud. The synthetic
zero-offset result does not verify alignment against Quest native passthrough;
that registration remains unresolved.

### Current production glass policy

XrHud no longer requests or samples raw camera images for glass. It renders
FluidGlass over transparent virtual-scene buffers and leaves the real room to
Quest's native compositor, both inside and outside panels. This eliminates the
duplicate-camera misregistration while preserving surrounding passthrough.
Real-room refraction has been removed, not solved; virtual-content refraction
and reflections remain. Glass-only camera startup and its UI control were removed.
Perception's explicit live camera/mic controls are unchanged.
