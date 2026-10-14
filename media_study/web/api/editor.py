# -*- coding: utf-8 -*-
"""Редактор одного видео: манифест, правки фрагментов, звук, история (Ctrl+Z).

Часть сервера (media_study/web/server.py): маршруты регистрируются на тот же app.
"""
import json

from fastapi import HTTPException, Response
from pydantic import BaseModel

from media_study.core.audio import AUDIO_RATE, sample_for_frame, wav_slice
from media_study.web import library
from media_study.web.manifest_store import ManifestStore
from ..server import _public, app, project
from .agent import _pull_texts_from_anki


# -- редактор одного видео ------------------------------------------------------------


class UpdateFragmentRequest(BaseModel):
    algo_start_frame: int | None = None
    algo_end_frame: int | None = None
    text: str | None = None
    text_marks: str | None = None  # разметка правки (см. Fragment.text_marks)
    needs_review: bool | None = None
    review_note: str | None = None
    link: bool = False  # режим "связанные границы" (см. ManifestStore.update_fragment)


class UnvoicedRequest(BaseModel):
    value: bool


@app.post("/api/p/{project_id}/fragments/{fragment_id}/unvoiced")
def set_unvoiced(project_id: str, fragment_id: str, body: UnvoicedRequest):
    """Отметка "не озвучено" (карточка без видео, с подписью Rover:)."""
    manifest = _call(lambda: project(project_id).store.set_unvoiced(fragment_id, body.value))
    return manifest.by_id(fragment_id).to_dict()


class HeardRequest(BaseModel):
    ranges: list[list[int]]
    rebase: bool = False


class MergeRequest(BaseModel):
    direction: str


class SplitRequest(BaseModel):
    current_frame: int


class PaddingRequest(BaseModel):
    side: str  # "left" | "right"
    direction: int  # +1 увеличить, -1 уменьшить


def _call(action):
    """Ошибки хранилища — в понятные ответы: нет фрагмента -> 404, нельзя -> 400."""
    try:
        return action()
    except KeyError as error:
        raise HTTPException(status_code=404, detail=str(error))
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error))


@app.get("/api/p/{project_id}/manifest")
def get_manifest(project_id: str):
    p = project(project_id)
    p.prepare()
    from media_study.web.library import title_of

    data = _public(p.store.load())
    # Название – заданное вручную в окне видео (если есть): его показывает меню "Сейчас правится".
    data["video"]["title"] = title_of(p.dir)
    data["video"]["group"] = library.group_of(p.dir)  # автор – над названием в ссылке меню
    # Аудио без видео: редактор показывает фон с кругом вместо картинки.
    data["video"]["audio_only"] = bool(library.video_info(p.dir).get("audio_only"))
    # Режим "говорящие на карточках" этого видео (кнопка в редакторе).
    data["video"]["show_speakers"] = library.show_speakers(p.dir)
    return data


@app.post("/api/p/{project_id}/fragments/{fragment_id}/sound-only")
def set_sound_only(project_id: str, fragment_id: str, body: UnvoicedRequest):
    """Отметка "только озвучка" (в карточке – звук без картинки)."""
    manifest = _call(lambda: project(project_id).store.set_sound_only(fragment_id, body.value))
    return manifest.by_id(fragment_id).to_dict()


class SpeakersRequest(BaseModel):
    on: bool


def _fragment_signature(fragment) -> str:
    """Отпечаток правки фрагмента (всё, кроме отметок этапа 3) – изменился ли он с момента снимка."""
    import hashlib

    data = {k: v for k, v in fragment.to_dict().items() if k not in ("exported", "anki_flagged")}
    return hashlib.md5(json.dumps(data, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


@app.post("/api/p/{project_id}/speakers")
def set_speakers(project_id: str, body: SpeakersRequest):
    """
    Режим "говорящие на карточках" видео. Касается всех карточек сразу:
    уже переданные в Anki (и переведённые) возвращаются на повторную
    передачу – помечаются вернувшимися, при следующей передаче их карточки
    обновятся (клип не перекодируется, перевод на обороте остаётся).
    """
    p = project(project_id)
    settings = library.project_settings(p.dir)
    previous = bool(settings.get("show_speakers", library.show_speakers(p.dir)))
    if previous == body.on and "show_speakers" in settings:
        return {"manifest": None, "returned": 0, "restored": 0, "on": body.on}
    settings["show_speakers"] = body.on
    library.save_project_settings(p.dir, settings)
    from media_study.core.manifest import STATUS_ACTIVE

    # Снимок прошлого переключения: режим нажали случайно и вернули обратно –
    # фрагменты, которые с тех пор не трогали, снова считаются переданными в
    # Anki (их карточки не менялись). Изменённые остаются вернувшимися.
    undo_path = p.dir / "speakers_undo.json"
    undo = library.read_json(undo_path, None)
    manifest = p.store.load()
    ids = [f.id for f in manifest.fragments if f.exported and f.status == STATUS_ACTIVE]
    before = {f.id: {"flagged": bool(f.anki_flagged)} for f in manifest.fragments if f.id in set(ids)}
    for entry in library.export_index(p.dir):
        if entry["fragment_id"] in before:
            before[entry["fragment_id"]]["redo"] = bool(entry.get("redo"))
    if ids:
        p.store.return_from_stage3(ids)
        try:
            _pull_texts_from_anki(project_id, ids)
        except Exception as error:  # Anki закрыт – правки из Anki подтянутся при следующем возврате
            print(f"Говорящие: тексты из Anki не подтянуты ({error})", flush=True)
    manifest = p.store.load()
    restored = {}
    if undo and bool(undo.get("on")) == body.on:
        snapshot = undo.get("fragments") or {}
        for f in manifest.fragments:
            state = snapshot.get(f.id)
            if state and f.id not in before and not f.exported and f.status == STATUS_ACTIVE and _fragment_signature(f) == state.get("sig"):
                restored[f.id] = state
        if restored:
            p.store.restore_to_stage3(restored)
    # Новый снимок – по только что вернувшимся (их отпечаток – уже после
    # подтягивания текстов из Anki); вернуть их можно, снова выбрав прежний режим.
    if ids:
        current = {f.id: f for f in manifest.fragments}
        snapshot = {i: {**before[i], "sig": _fragment_signature(current[i])} for i in ids if i in current}
        undo_path.write_text(json.dumps({"on": previous, "fragments": snapshot}, ensure_ascii=False), encoding="utf-8")
    elif undo_path.exists():
        undo_path.unlink()
    return {"manifest": get_manifest(project_id), "returned": len(ids), "restored": len(restored), "on": body.on}


@app.patch("/api/p/{project_id}/fragments/{fragment_id}")
def update_fragment(project_id: str, fragment_id: str, body: UpdateFragmentRequest):
    store = project(project_id).store
    manifest = _call(lambda: store.update_fragment(fragment_id, **body.model_dump()))
    # Сдвинутые вместе с этой границей соседи (режим "связанные границы").
    linked = [manifest.by_id(i).to_dict() for i in getattr(store, "last_linked", [])]
    return {**manifest.by_id(fragment_id).to_dict(), "linked": linked}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/heard")
def mark_heard(project_id: str, fragment_id: str, body: HeardRequest):
    store = project(project_id).store
    manifest = _call(lambda: store.mark_heard(fragment_id, body.ranges, body.rebase))
    return manifest.by_id(fragment_id).to_dict()


@app.post("/api/p/{project_id}/fragments/{fragment_id}/reset")
def reset_fragment(project_id: str, fragment_id: str):
    store = project(project_id).store
    return {"manifest": _public(_call(lambda: store.reset(fragment_id)))}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/padding")
def change_padding(project_id: str, fragment_id: str, body: PaddingRequest):
    store = project(project_id).store
    manifest = _call(lambda: store.change_side_padding(fragment_id, body.side, body.direction))
    return manifest.by_id(fragment_id).to_dict()


@app.post("/api/p/{project_id}/fragments/{fragment_id}/delete")
def soft_delete_fragment(project_id: str, fragment_id: str, link: bool = False):
    # link – режим "связанные границы" (см. ManifestStore.soft_delete).
    store = project(project_id).store
    return {"manifest": _public(_call(lambda: store.soft_delete(fragment_id, link=link)))}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/restore")
def restore_fragment(project_id: str, fragment_id: str, link: bool = False):
    store = project(project_id).store
    return {"manifest": _public(_call(lambda: store.restore(fragment_id, link=link)))}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/delete_final")
def hard_delete_fragment(project_id: str, fragment_id: str):
    store = project(project_id).store
    manifest, nearest_left_id = _call(lambda: store.hard_delete(fragment_id))
    return {"manifest": _public(manifest), "nearest_left_fragment_id": nearest_left_id}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/merge")
def merge_fragment(project_id: str, fragment_id: str, body: MergeRequest):
    store = project(project_id).store
    manifest, merged_id = _call(lambda: store.merge(fragment_id, body.direction))
    # junction – где в новом тексте стык двух фраз (подсветка в редакторе).
    return {"manifest": _public(manifest), "merged_fragment_id": merged_id, "junction": store.last_junction}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/split")
def split_fragment(project_id: str, fragment_id: str, body: SplitRequest):
    store = project(project_id).store
    manifest, left_id, right_id = _call(lambda: store.split(fragment_id, body.current_frame))
    return {"manifest": _public(manifest), "left_fragment_id": left_id, "right_fragment_id": right_id}


# Кусок звука на окно фрагмента [start_frame, end_frame) — WAV, точно по сэмплам.
@app.get("/api/p/{project_id}/audio")
def audio(project_id: str, start_frame: int, end_frame: int):
    p = project(project_id)
    p.prepare()
    if not p.audio_path.exists():
        raise HTTPException(status_code=404, detail="у видео нет звуковой дорожки")
    fps = p.store.load().video.fps
    data, start_sample = wav_slice(p.audio_path, sample_for_frame(start_frame, fps), sample_for_frame(end_frame, fps))
    return Response(
        content=data,
        media_type="audio/wav",
        headers={"X-Audio-Start-Sample": str(start_sample), "X-Audio-Rate": str(AUDIO_RATE)},
    )


# История у каждого фрагмента своя: "назад"/"вперёд" — для текущего фрагмента.
def _history(store: ManifestStore, fragment_id: str) -> dict:
    return {"can_undo": store.can_undo(fragment_id), "can_redo": store.can_redo(fragment_id)}


@app.get("/api/p/{project_id}/fragments/{fragment_id}/history")
def get_history(project_id: str, fragment_id: str):
    return _history(project(project_id).store, fragment_id)


@app.post("/api/p/{project_id}/fragments/{fragment_id}/undo")
def undo(project_id: str, fragment_id: str):
    store = project(project_id).store
    manifest, focus_id = _call(lambda: store.undo(fragment_id))
    return {"manifest": _public(manifest), "focus_fragment_id": focus_id, "history": _history(store, focus_id)}


@app.post("/api/p/{project_id}/fragments/{fragment_id}/redo")
def redo(project_id: str, fragment_id: str):
    store = project(project_id).store
    manifest, focus_id = _call(lambda: store.redo(fragment_id))
    return {"manifest": _public(manifest), "focus_fragment_id": focus_id, "history": _history(store, focus_id)}
