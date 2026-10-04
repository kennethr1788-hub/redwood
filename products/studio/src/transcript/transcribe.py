#!/usr/bin/env python3
"""Local-only, bounded small-model inference; prints data, never commands."""
import os
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", HF_HUB_DISABLE_IMPLICIT_TOKEN="1", TOKENIZERS_PARALLELISM="false", OMP_NUM_THREADS="4")
from array import array
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys
import time
import wave

MODEL_FILES = {
    "config.json": "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828",
    "model.bin": "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
    "tokenizer.json": "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
    "vocabulary.txt": "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
}


def main():
    if len(sys.argv) != 3:
        raise ValueError("Existing local model and WAV paths required")
    model_path, audio_path = [Path(value).resolve(strict=True) for value in sys.argv[1:]]
    os.environ.update(HF_HOME=str(audio_path.parent / "hf-cache"), XDG_CACHE_HOME=str(audio_path.parent / "cache"))
    if importlib.metadata.version("faster-whisper") != "1.2.1":
        raise ValueError("Studio requires the qualified faster-whisper 1.2.1 environment")
    for name, expected in MODEL_FILES.items():
        digest = hashlib.sha256()
        with (model_path / name).open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError("Local model differs from the qualified small-model revision: " + name)
    with wave.open(str(audio_path), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
        if audio.getsampwidth() != 2 or audio.getframerate() != 16000 or audio.getnchannels() != 1 or not 0 < duration <= 120.1:
            raise ValueError("ASR requires mono 16 kHz audio of at most 120 seconds")
        # Exact digital silence only. Do not classify quiet speech as silence.
        silent = True
        for chunk in iter(lambda: audio.readframes(16000), b""):
            if any(array("h", chunk)):
                silent = False
                break
    from faster_whisper import WhisperModel
    started = time.monotonic()
    model = None if silent else WhisperModel(str(model_path), device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, local_files_only=True)
    segments, info = ([], None) if silent else model.transcribe(str(audio_path), language="en", beam_size=1, temperature=0, condition_on_previous_text=False, vad_filter=False, word_timestamps=True)
    result = []
    for segment in segments:
        if len(result) >= 200 or len(segment.text) > 10000:
            raise ValueError("Transcript exceeds bounded output limits")
        words = [{"start": w.start, "end": w.end, "word": w.word} for w in (segment.words or [])]
        if len(words) > 2000:
            raise ValueError("Transcript exceeds bounded word limits")
        result.append({"start": segment.start, "end": segment.end, "text": segment.text.strip(), "words": words})
    print(json.dumps({
        "schemaVersion": 1,
        "segments": result,
        "language": "en" if silent else info.language,
        "durationSeconds": duration,
        "inferenceSeconds": round(time.monotonic() - started, 3),
        "provenance": {
            "engine": "faster-whisper",
            "versions": {name: importlib.metadata.version(name) for name in ["faster-whisper", "ctranslate2", "av", "numpy"]},
            "model": "Systran/faster-whisper-small",
            "revision": "536b0662742c02347bc0e980a01041f333bce120",
            "modelSha256": MODEL_FILES["model.bin"],
            "settings": {"device": "cpu", "computeType": "int8", "cpuThreads": 4, "numWorkers": 1, "beamSize": 1, "language": "en", "vadFilter": False, "wordTimestamps": True},
            "offline": True,
        },
    }, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Local transcription failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
