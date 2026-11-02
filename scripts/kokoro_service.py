"""Local helper for Kokoro prompts and pilot-reviewed checklist JSON files."""

from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock
import json
import os
import re

import soundfile as sf
from kokoro_onnx import Kokoro


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "public" / "audio" / "generated"
AIRCRAFT_DATA_DIR = ROOT / "data" / "aircraft"
MODEL_DIR = Path(os.environ.get("SECONDSEAT_KOKORO_MODEL_DIR", "/tmp/secondseat-kokoro-model"))
HOST = "127.0.0.1"
PORT = int(os.environ.get("SECONDSEAT_KOKORO_PORT", "8787"))
VOICE = os.environ.get("SECONDSEAT_KOKORO_VOICE", "af_heart")
SPEED = float(os.environ.get("SECONDSEAT_KOKORO_SPEED", "0.96"))
VOICE_PIPELINE_VERSION = "r182-kokoro-v2"
MAX_TEXTS = 800
MAX_TEXT_LENGTH = 500
MAX_BODY_BYTES = 2 * 1024 * 1024

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
AIRCRAFT_DATA_DIR.mkdir(parents=True, exist_ok=True)
kokoro = Kokoro(str(MODEL_DIR / "kokoro-v1.0.int8.onnx"), str(MODEL_DIR / "voices-v1.0.bin"))
generation_lock = Lock()


def normalize_for_speech(text: str) -> str:
    """Expand common aviation shorthand without changing the saved checklist."""
    replacements = (
        (r"\bDEN\.?\s*ALT\.?\b", "density altitude"),
        (r"\bA\.R\.O\.W\.", "A R O W"),
        (r"\bXPDR\b", "transponder"),
        (r"\bSQWK\b", "squawk"),
        (r"\bATIS\b", "A T I S"),
        (r"\bAWOS\b", "A W O S"),
        (r"\bADS-?B\b", "A D S B"),
        (r"\bKIAS\b", "knots indicated airspeed"),
        (r"\bRPM\b", "R P M"),
        (r"\bH\.I\.", "heading indicator"),
        (r"\bREQ\.?\b", "required"),
        (r"\bINT\.?\s*/\s*EXT\.?\b", "interior and exterior"),
    )
    spoken = text
    for pattern, replacement in replacements:
        spoken = re.sub(pattern, replacement, spoken, flags=re.IGNORECASE)
    spoken = spoken.replace("&", " and ").replace("°", " degrees ")
    spoken = re.sub(r"(?<=\d)\s*[-–]\s*(?=\d)", " to ", spoken)
    spoken = re.sub(r"\s*/\s*", " or ", spoken)
    spoken = re.sub(r"\s+", " ", spoken).strip()
    return spoken


def asset_name(text: str) -> str:
    fingerprint = sha256(f"{VOICE_PIPELINE_VERSION}|{VOICE}|{SPEED}|{text}".encode("utf-8")).hexdigest()[:24]
    return f"{fingerprint}.wav"


def checklist_filename(profile: dict) -> str:
    aircraft = profile.get("aircraft")
    if not isinstance(aircraft, dict):
        raise ValueError("The profile is missing aircraft metadata.")
    source_name = aircraft.get("id") or aircraft.get("displayName")
    if not isinstance(source_name, str) or not source_name.strip():
        raise ValueError("The aircraft id or display name is required.")
    slug = re.sub(r"[^a-z0-9]+", "-", source_name.lower()).strip("-")[:80]
    if not slug:
        raise ValueError("Could not create a safe checklist filename.")
    return f"{slug}.json"


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self.send_json(204, {})

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(200, {"ready": True, "voice": VOICE})
        elif re.fullmatch(r"/audio/generated/[a-f0-9]{24}\.wav", self.path):
            filename = self.path.rsplit("/", 1)[-1]
            audio_path = OUTPUT_DIR / filename
            if not audio_path.is_file():
                self.send_json(404, {"error": "Audio file not found."})
                return
            body = audio_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/checklists":
            profiles: list[dict] = []
            warnings: list[str] = []
            for path in sorted(AIRCRAFT_DATA_DIR.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
                try:
                    profile = json.loads(path.read_text(encoding="utf-8"))
                    if not isinstance(profile, dict) or profile.get("schemaVersion") != 1:
                        raise ValueError("unsupported schema version")
                    profiles.append(profile)
                except (OSError, ValueError, json.JSONDecodeError) as error:
                    warnings.append(f"{path.name}: {error}")
            self.send_json(200, {"profiles": profiles, "warnings": warnings})
        else:
            self.send_json(404, {"error": "Not found."})

    def read_payload(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("Invalid request size.")
        payload = json.loads(self.rfile.read(length))
        if not isinstance(payload, dict):
            raise ValueError("Expected a JSON object.")
        return payload

    def save_checklist(self, payload: dict) -> None:
        profile = payload.get("profile")
        if not isinstance(profile, dict) or profile.get("schemaVersion") != 1:
            raise ValueError("Expected a valid SecondSeat schemaVersion 1 profile.")
        checklists = profile.get("checklists")
        if not isinstance(checklists, list) or not checklists:
            raise ValueError("The profile must contain at least one checklist.")
        filename = checklist_filename(profile)
        output = AIRCRAFT_DATA_DIR / filename
        try:
            with output.open("x", encoding="utf-8") as file:
                json.dump(profile, file, ensure_ascii=False, indent=2)
                file.write("\n")
        except FileExistsError:
            self.send_json(409, {"error": f"{filename} already exists. Rename the aircraft/checklist before saving."})
            return
        self.send_json(201, {"saved": True, "filename": filename, "path": f"data/aircraft/{filename}"})

    def delete_checklist(self, payload: dict) -> None:
        aircraft_id = payload.get("aircraftId")
        if not isinstance(aircraft_id, str) or not aircraft_id.strip():
            raise ValueError("The aircraft id is required.")
        if aircraft_id == "cessna-r182-1981":
            self.send_json(403, {"error": "The bundled R182 sample cannot be deleted."})
            return
        filename = checklist_filename({"aircraft": {"id": aircraft_id}})
        output = AIRCRAFT_DATA_DIR / filename
        try:
            output.unlink()
        except FileNotFoundError:
            self.send_json(404, {"error": f"{filename} was not found."})
            return
        self.send_json(200, {"deleted": True, "filename": filename})

    def do_POST(self) -> None:
        if self.path not in {"/generate", "/save-checklist", "/delete-checklist"}:
            self.send_json(404, {"error": "Not found."})
            return
        try:
            payload = self.read_payload()
            if self.path == "/save-checklist":
                self.save_checklist(payload)
                return
            if self.path == "/delete-checklist":
                self.delete_checklist(payload)
                return
            texts = payload.get("texts")
            if not isinstance(texts, list) or not texts or len(texts) > MAX_TEXTS:
                raise ValueError(f"Provide between 1 and {MAX_TEXTS} prompts.")
            cleaned = list(dict.fromkeys(text.strip() for text in texts if isinstance(text, str) and text.strip()))
            if not cleaned or any(len(text) > MAX_TEXT_LENGTH for text in cleaned):
                raise ValueError(f"Each prompt must be between 1 and {MAX_TEXT_LENGTH} characters.")

            assets: dict[str, str] = {}
            generated = 0
            with generation_lock:
                for text in cleaned:
                    spoken_text = normalize_for_speech(text)
                    filename = asset_name(spoken_text)
                    output = OUTPUT_DIR / filename
                    if not output.exists():
                        samples, sample_rate = kokoro.create(spoken_text, voice=VOICE, speed=SPEED, lang="en-us")
                        sf.write(output, samples, sample_rate, subtype="PCM_16")
                        generated += 1
                    assets[text] = f"/api/checklists/extract?audio={filename}"
            self.send_json(200, {"assets": assets, "generated": generated, "cached": len(cleaned) - generated})
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:  # Keep one failed local operation from crashing the service.
            operation = "Checklist save" if self.path == "/save-checklist" else "Checklist delete" if self.path == "/delete-checklist" else "Kokoro generation"
            self.send_json(500, {"error": f"{operation} failed: {error}"})

    def log_message(self, format: str, *args: object) -> None:
        print(f"[kokoro] {format % args}")


if __name__ == "__main__":
    print(f"SecondSeat Kokoro service listening on http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
