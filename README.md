# SecondSeat

SecondSeat is a local prototype of a voice-guided checklist partner for simulated single-pilot flying. It turns a pilot-reviewed aircraft checklist into spoken instructions, accepts simple hands-free navigation commands, and can suggest checklists from simulated GPS flight phases.

> **Demo only.** SecondSeat is not an FAA-approved checklist or certified avionics system. Always use the approved POH/AFM and checklist for the specific aircraft.

## What the prototype does

- Runs a bundled 1981 Cessna R182 Skylane RG sample with normal, emergency, run-up, taxi, retractable-gear, and optional night procedures.
- Imports up to eight PNG/JPEG checklist images and sends them to the OpenAI Responses API for schema-constrained extraction.
- Opens every extracted checklist in an editable review screen before it can be used.
- Allows an item action/state to be empty. In that case, the challenge is treated as a standalone instruction and is spoken only once.
- Saves reviewed profiles as versioned JSON in `data/aircraft/`.
- Automatically discovers saved JSON profiles at startup and lists them under **Saved Checklists**.
- Loads or deletes saved profiles from the home screen. The bundled R182 sample cannot be deleted.
- Generates missing speech locally with Kokoro, caches WAV files by content hash, and reuses them on later runs.
- Advances an active checklist when the pilot says `checked` or `next`, goes back on `back`, or uses the on-screen controls.
- Requests microphone access only while a checklist is active and listening for a command.
- Replays a complete mock flight with a draggable timeline and deterministic GPS/telemetry data.
- Detects PARKED, TAXI, TAKEOFF, CLIMB, CRUISE, DESCENT, APPROACH, and LANDING states and waits for pilot confirmation before opening a suggested checklist.
- Pauses at hold short so the pilot can choose **Run-up** or **Ready for takeoff**. A new suggestion is queued when another checklist is already active.

## Run locally

Requirements:

- Node.js 22.13 or newer
- pnpm
- Python 3.12
- A browser with Web Speech API support for voice commands

Install the web dependencies and one-time Kokoro environment:

```bash
pnpm install
SECONDSEAT_PYTHON_BOOTSTRAP=python3.12 ./scripts/setup_kokoro.sh
cp .env.example .env.local
```

The two environment files have different purposes:

| File | Purpose | Commit it? |
| --- | --- | --- |
| `.env.example` | A public template showing which variables the app supports. It contains no real secrets. | Yes |
| `.env.local` | Your private local configuration and real API key. The app reads this file when it starts. | No |

Copy the template only once. After that, edit `.env.local`; do not put a real API key in `.env.example`. The included `.gitignore` excludes `.env.local` and other `.env*` files while explicitly retaining `.env.example`.

Add an OpenAI API key to your private `.env.local` if checklist-image extraction is needed:

```dotenv
OPENAI_API_KEY=your_key_here
OPENAI_VISION_MODEL=gpt-6.1-terra
SECONDSEAT_KOKORO_MODEL_DIR=/tmp/secondseat-kokoro-model
SECONDSEAT_KOKORO_PORT=8787
```

The OpenAI key is used only by the server-side extraction route and is never sent to the browser. Kokoro is local and does not require an API key.

Start both the web app and Kokoro service:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Demo walkthrough

### Bundled R182

1. Select **Use R182 Skylane RG**.
2. Review the normal and emergency libraries and enable **Night operations** if desired.
3. Confirm that the checklist was reviewed against its source.
4. Select **Confirm, generate voice & start**.
5. Use the flight timeline or phase controls to inspect the simulated flight.
6. When a checklist is suggested, confirm it before execution.
7. Say `checked` or `next` after each spoken instruction, say `back` to return, or use the buttons.
8. At hold short, choose **Run-up** or **Ready for takeoff**. The demo remains paused until the hold-short flow is released.

### Import and save a checklist

1. Select **Upload images** and enter an aircraft/checklist name.
2. Add clear PNG or JPEG images in printed order. The current limit is eight images, 16 MB each, with a 160 MB web-request limit.
3. Wait for structured extraction, then review and edit every section and item.
4. Confirm the pilot-review statement.
5. Select **Save JSON** to write the profile to `data/aircraft/<aircraft-id>.json`.
6. Return home. The profile appears under **Saved Checklists** and can be reopened without another OpenAI request.
7. Use the trash button beside a saved profile to delete it after confirmation.

SecondSeat never substitutes sample checklist data when extraction fails. A failed import remains an error for the user to correct or retry.

## Architecture

Aircraft content is data rather than page code:

- `data/aircraft/*.json` contains aircraft metadata and checklist libraries.
- `data/schema/aircraft-profile.schema.json` documents the versioned JSON contract.
- `lib/checklist-schema.ts` validates every bundled, extracted, or saved profile before the interface uses it.
- `lib/aircraft-profiles.ts` registers the bundled R182 sample.
- `app/api/checklists/extract/route.ts` handles server-side OpenAI extraction and proxies generated WAV responses to the same web origin.
- `scripts/kokoro_service.py` generates speech, serves the saved-profile registry, and handles local save/delete operations.
- `lib/flight-phase-detector.ts` deterministically maps simulated telemetry to flight phases.
- The review editor, checklist runner, GPS suggestions, and voice generator all consume the same validated profile shape.

The local checklist registry scans `data/aircraft/*.json` at startup. Saving or deleting a profile updates the home-screen list immediately; restarting the app reconstructs the list from disk.

## Voice pipeline

SecondSeat uses [kokoro-onnx](https://github.com/thewh1teagle/kokoro-onnx) with one consistent local voice pipeline for bundled and imported checklist prompts.

When the pilot starts a reviewed profile:

1. The browser collects the spoken phrases required by that profile.
2. Existing content-hashed WAV files are reused.
3. Missing phrases are generated by the local Kokoro service.
4. The web app serves generated audio through a same-origin route for reliable browser playback.
5. The browser listens only for `checked`, `next`, or `back` while an active checklist expects a command.

Deleting a saved profile removes its JSON file and browser voice-cache mappings. Generated WAV files may remain in the shared content-addressed cache because identical phrases can be reused by other profiles.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for attribution and licenses.

## Implemented, mocked, and deferred

Implemented:

- Versioned modular aircraft profiles and runtime validation
- OpenAI image-to-checklist extraction with strict structured output
- Editable pilot-review gate
- Local JSON save, automatic discovery, load, and confirmed delete
- Full R182 sample library plus optional night prompts
- Local Kokoro generation and content-hash caching
- Browser voice commands with multi-candidate recognition and on-screen fallback
- Checklist suggestion confirmation, queueing, and hold-short branching
- Responsive cockpit-style interface

Mocked:

- GPS position, altitude, speed, vertical speed, and flight timeline
- Flight-phase-triggered checklist suggestions

Deferred:

- Real GPS, sensor, EFB, or ForeFlight integration
- Mobile packaging and offline distribution
- Real-world cockpit usability and safety testing
- Certified or operational use

## Safety limitations

This software is a prototype, not a substitute for an aircraft POH/AFM, approved checklist, pilot judgment, training, or required flight procedures. Extracted text may be incomplete or wrong and must be reviewed against its source.

SecondSeat records pilot navigation through a reviewed list. It cannot verify that the aircraft is physically configured as instructed, that a spoken confirmation is truthful, or that a suggested checklist is operationally appropriate.

## AI development disclosure

AI coding tools were used for implementation support, interface development, debugging, and validation. Safety-relevant checklist sequencing, command handling, flight-phase detection, queueing, and completion state are deterministic rather than delegated to an LLM. The LLM is used only to create an editable structured draft from uploaded checklist images.
