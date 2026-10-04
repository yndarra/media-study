# -*- coding: utf-8 -*-
"""
Локальный Whisper (faster-whisper): какие модели установлены, установка
моделей и библиотек видеокарты, запуск на процессоре или видеокарте.

Модели скачиваются в кэш Hugging Face (~/.cache/huggingface/hub) – один раз.
Для видеокарты NVIDIA нужны библиотеки CUDA (cuBLAS и cuDNN) – они ставятся
pip-пакетами nvidia-cublas-cu12 / nvidia-cudnn-cu12 (~1–1,5 ГБ); их папки
bin подключаются при запуске (cuda_dll_dirs).

Нагрузка на видеокарту: в отличие от процессора, "оставить ядра свободными"
у видеокарты нельзя – она делится по времени, а не по ядрам. Бережный режим
(whisper_gentle) берёт облегчённую точность (int8_float16 – меньше памяти и
работы) и делает короткие паузы между кусками распознавания: видеокарта
успевает отдохнуть, интерфейс и игры не подтормаживают.
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
from pathlib import Path

# Модели: имя для faster-whisper, подпись, примерный размер (ГБ).
MODELS = [
    ("large-v3", "large-v3 – самая точная", 3.1),
    ("large-v3-turbo", "large-v3-turbo – почти как large-v3, в разы быстрее", 1.6),
    ("distil-large-v3", "distil-large-v3 – быстрая, только английский", 1.5),
    ("medium.en", "medium.en – средняя, только английский", 1.5),
    ("small.en", "small.en – маленькая, только английский", 0.5),
]
CUDA_PACKAGES = ["nvidia-cublas-cu12", "nvidia-cudnn-cu12>=9,<10"]
GENTLE_PAUSE = 0.35  # с – пауза между кусками в бережном режиме

# Идущие установки: {"what": "model:<имя>" | "cuda", "error": ...}
INSTALLS: dict[str, dict] = {}


def _repo(name: str) -> str:
    from faster_whisper.utils import _MODELS

    return _MODELS.get(name, name)


def model_installed(name: str) -> bool:
    from huggingface_hub import try_to_load_from_cache

    path = try_to_load_from_cache(_repo(name), "model.bin")
    return isinstance(path, str) and Path(path).exists()


def cuda_dll_dirs() -> list[str]:
    """Папки bin пакетов nvidia-* (cuBLAS, cuDNN) – подключить перед запуском на видеокарте."""
    dirs = []
    try:
        import nvidia

        for base in nvidia.__path__:
            for sub in ("cublas", "cudnn", "cuda_runtime", "cuda_nvrtc"):
                d = Path(base) / sub / "bin"
                if d.is_dir():
                    dirs.append(str(d))
    except ImportError:
        pass
    for d in dirs:
        if d not in os.environ.get("PATH", ""):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
        try:
            os.add_dll_directory(d)
        except (OSError, AttributeError):
            pass
    return dirs


def gpu_status() -> dict:
    """Видеокарта: есть ли NVIDIA, её имя, установлены ли библиотеки CUDA."""
    name = ""
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                             capture_output=True, text=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
        name = out.stdout.strip().splitlines()[0] if out.returncode == 0 and out.stdout.strip() else ""
    except (OSError, subprocess.SubprocessError):
        pass
    libs = False
    if cuda_dll_dirs():
        import ctypes

        try:
            ctypes.WinDLL("cublas64_12.dll")
            ctypes.WinDLL("cudnn_ops64_9.dll")
            libs = True
        except OSError:
            libs = False
    return {"available": bool(name), "name": name, "libs": libs}


def status() -> dict:
    return {
        "models": [{"name": n, "label": label, "size_gb": size, "installed": model_installed(n)} for n, label, size in MODELS],
        "gpu": gpu_status(),
        "installs": {k: dict(v) for k, v in INSTALLS.items()},
    }


def _run_install(key: str, action) -> None:
    INSTALLS[key] = {"running": True, "error": ""}
    try:
        action()
    except Exception as error:  # нет сети, места и т.п.
        INSTALLS[key]["error"] = str(error)[:300]
    finally:
        INSTALLS[key]["running"] = False


def install_model(name: str) -> None:
    """Скачать модель в фоне (кэш Hugging Face)."""
    from faster_whisper import download_model

    key = f"model:{name}"
    if INSTALLS.get(key, {}).get("running"):
        return
    threading.Thread(target=_run_install, args=(key, lambda: download_model(name)), daemon=True).start()


def install_cuda() -> None:
    """Поставить библиотеки CUDA для видеокарты (pip, в фоне)."""
    if INSTALLS.get("cuda", {}).get("running"):
        return

    def run():
        result = subprocess.run([sys.executable, "-m", "pip", "install", "-q", *CUDA_PACKAGES],
                                capture_output=True, text=True, creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode != 0:
            raise RuntimeError((result.stderr or result.stdout).strip()[-300:])

    threading.Thread(target=_run_install, args=("cuda", run), daemon=True).start()


def load_model(settings: dict, log=print):
    """
    Модель по настройкам: whisper_model, whisper_device ("cpu" / "cuda"),
    whisper_gentle. Видеокарта не завелась – откат на процессор (с записью в журнал).
    Возвращает (модель, устройство, пауза между кусками).
    """
    from faster_whisper import WhisperModel

    from media_study.core.resources import cpu_threads

    name = settings.get("whisper_model") or "medium.en"
    if not model_installed(name):
        log(f"Модель {name} ещё не скачана – скачиваю (один раз)…")
    if settings.get("whisper_device") == "cuda":
        cuda_dll_dirs()
        gentle = bool(settings.get("whisper_gentle", False))
        try:
            model = WhisperModel(name, device="cuda", compute_type="int8_float16" if gentle else "float16")
            log(f"Распознавание: {name} на видеокарте" + (" (бережно)" if gentle else ""))
            return model, "cuda", GENTLE_PAUSE if gentle else 0.0
        except Exception as error:
            log(f"Видеокарта не завелась ({error}) – распознаю на процессоре.")
    model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=cpu_threads())
    log(f"Распознавание: {name} на процессоре")
    return model, "cpu", 0.0
