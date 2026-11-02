"""Generate the bundled Kokoro voice prompts used by the local demo."""

from pathlib import Path
import json
import re

import soundfile as sf
from kokoro_onnx import Kokoro


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "public" / "audio" / "kokoro"
MODEL_DIR = Path("/tmp/secondseat-kokoro-model")

CORE_CHALLENGES = [
    "Airspeed",
    "Wing flaps",
    "Power",
    "Seats and seat belts",
    "Fuel selector valve",
    "Mixture",
    "Cowl flaps",
    "Seats, seat belts, and shoulder harnesses",
    "Landing gear",
    "Landing gear indication",
    "Carburetor heat",
    "Propeller",
]

profiles = [json.loads(path.read_text()) for path in sorted((ROOT / "data" / "aircraft").glob("*.json"))]
CHALLENGES = CORE_CHALLENGES + [
    item["challenge"]
    for profile in profiles
    for checklist in profile["checklists"]
    for item in checklist["items"]
]
SECTION_NAMES = ["CLIMB", "BEFORE LANDING"] + [
    checklist["name"]
    for profile in profiles
    for checklist in profile["checklists"]
]
PROMPTS = ["Hold short. Run-up, or ready for takeoff?"] + [
    f"{name.lower()} checklist complete." for name in SECTION_NAMES
]

for profile in profiles:
    for checklist in profile["checklists"]:
        if checklist.get("triggerPhase"):
            PROMPTS.append(
                f"{checklist['triggerPhase']} detected. Start {checklist['name']} checklist? Say yes or tap confirm."
            )
        for item in checklist["items"]:
            action = item["expected"].strip()
            PROMPTS.append(
                f"{item['challenge']}. {action}." if action else f"{item['challenge']}."
            )

for challenge in dict.fromkeys(CHALLENGES):
    PROMPTS.extend(
        [
            f"{challenge}?",
            f"{challenge}, confirmed.",
            f"{challenge} not confirmed.",
        ]
    )


def filename_for(text: str) -> str:
    suffix = "-question" if text.endswith("?") else ""
    stem = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return f"{stem}{suffix}.wav"


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    kokoro = Kokoro(
        str(MODEL_DIR / "kokoro-v1.0.int8.onnx"),
        str(MODEL_DIR / "voices-v1.0.bin"),
    )

    for text in dict.fromkeys(PROMPTS):
        output = OUTPUT_DIR / filename_for(text)
        if output.exists():
            continue
        samples, sample_rate = kokoro.create(
            text,
            voice="af_heart",
            speed=0.96,
            lang="en-us",
        )
        sf.write(output, samples, sample_rate, subtype="PCM_16")
        print(f"{output.name}: {text}")


if __name__ == "__main__":
    main()
