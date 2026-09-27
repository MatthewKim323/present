"""Opt-in enrollment CLI. Only embeddings are stored (perception/data/people.json), never photos or frames.

  uv run python -m perception.enroll --from-dir data/enroll/     # enroll/<name>/*.jpg, one folder per person
  uv run python -m perception.enroll --live "Alex"               # webcam: capture N samples of the largest face
  uv run python -m perception.enroll --list
  uv run python -m perception.enroll --check                     # leave-one-out self-match report
  uv run python -m perception.enroll --remove alex
  uv run python -m perception.enroll --meta alex role=founder company=Acme
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from .config import get_settings
from .events import slug
from .faces import Face, FaceEngine
from .people import PeopleStore, score_against

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".heic"}
AMBIGUOUS_RATIO = 0.7  # second face >= 70% of the largest's area -> can't tell who the photo is of


def pick_face(faces: list[Face]) -> tuple[Face | None, str | None]:
    if not faces:
        return None, "no face"
    faces = sorted(faces, key=lambda f: f.area, reverse=True)
    if len(faces) > 1 and faces[1].area >= AMBIGUOUS_RATIO * faces[0].area:
        return None, f"{len(faces)} faces of similar size"
    return faces[0], None


def load_image(path: Path) -> np.ndarray | None:
    img = cv2.imread(str(path))
    if img is None:
        return None
    h, w = img.shape[:2]
    s = min(1.0, 1600 / max(h, w))
    return cv2.resize(img, (int(w * s), int(h * s))) if s < 1 else img


def enroll_from_dir(root: Path, engine: FaceEngine, store: PeopleStore) -> dict[str, dict]:
    summary: dict[str, dict] = {}
    # photos: detect at full (downscaled-to-1600) res so small faces in group-ish shots still register
    engine.max_side = 1600
    for person_dir in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        name = person_dir.name
        embs, srcs, skipped = [], [], []
        for img_path in sorted(person_dir.iterdir()):
            if img_path.suffix.lower() not in IMG_EXT:
                continue
            img = load_image(img_path)
            if img is None:
                skipped.append((img_path.name, "unreadable"))
                continue
            face, why = pick_face(engine.detect(img))
            if face is None:
                skipped.append((img_path.name, why))
                continue
            embs.append(engine.embed(img, face))
            srcs.append(f"photo:{img_path.name}")
            del img
        display = name.replace("_", " ").replace("-", " ").title()
        if embs:
            store.replace_source(display, embs, srcs, prefix="photo:")
        summary[slug(display)] = {"name": display, "used": len(embs), "skipped": skipped}
    store.save()
    return summary


def leave_one_out(store: PeopleStore) -> None:
    """For every stored embedding: score vs own other samples, and vs the best other person."""
    th = store.threshold
    print(f"\nleave-one-out self-match (threshold {th:.3f}, score = mean of top-3 cosine)")
    all_same, all_diff = [], []
    for pid, p in store.people.items():
        n = len(p.embeddings)
        if n < 2:
            print(f"  {pid:<14} only {n} sample(s), skipped")
            continue
        correct = wrong = unknown = 0
        same_scores, diff_scores = [], []
        for i, e in enumerate(p.embeddings):
            own = score_against(e, p.embeddings[:i] + p.embeddings[i + 1 :])
            best_other, best_other_id = -1.0, None
            for qid, q in store.people.items():
                if qid == pid or not q.embeddings:
                    continue
                s = score_against(e, q.embeddings)
                if s > best_other:
                    best_other, best_other_id = s, qid
            same_scores.append(own)
            if best_other_id:
                diff_scores.append(best_other)
            if own >= th and own > best_other:
                correct += 1
            elif best_other >= th and best_other > own:
                wrong += 1
            else:
                unknown += 1
        all_same += same_scores
        all_diff += diff_scores
        line = f"  {pid:<14} n={n:<3} correct {correct}/{n}  wrong {wrong}  unknown {unknown}  own min/mean {min(same_scores):.3f}/{np.mean(same_scores):.3f}"
        if diff_scores:
            line += f"  best-other max/mean {max(diff_scores):.3f}/{np.mean(diff_scores):.3f}"
        print(line)
    if all_same and all_diff:
        gap = min(all_same) - max(all_diff)
        verdict = "SEPARATED" if min(all_same) >= th > max(all_diff) else "OVERLAP, tune threshold or add photos"
        print(f"  overall: lowest self {min(all_same):.3f}, highest cross {max(all_diff):.3f}, margin {gap:+.3f} -> {verdict}")


def enroll_live(name: str, engine: FaceEngine, store: PeopleStore, n: int, cam: int = 0) -> None:
    cap = cv2.VideoCapture(cam)
    if not cap.isOpened():
        sys.exit("cannot open webcam (grant camera permission to your terminal)")
    embs, last = [], 0.0
    print(f"capturing {n} samples of {name}; look at the camera, turn your head a little. q to abort")
    while len(embs) < n:
        ok, frame = cap.read()
        if not ok:
            continue
        face, why = pick_face(engine.detect(frame))
        view = frame.copy()
        if face is not None:
            x, y, w, h = face.bbox
            cv2.rectangle(view, (x, y), (x + w, y + h), (0, 255, 0), 2)
            if time.time() - last > 0.25:
                embs.append(engine.embed(frame, face))
                last = time.time()
        cv2.putText(view, f"{name}: {len(embs)}/{n} {why or ''}", (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
        cv2.imshow("enroll", view)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break
        del frame
    cap.release()
    cv2.destroyAllWindows()
    if embs:
        p = store.add(name, embs, src="live")
        print(f"enrolled {p.person_id}: +{len(embs)} samples, {len(p.embeddings)} total")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="perception.enroll")
    ap.add_argument("--from-dir", type=Path)
    ap.add_argument("--live", metavar="NAME")
    ap.add_argument("--samples", type=int, default=None)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--remove", metavar="PERSON_ID")
    ap.add_argument("--meta", nargs="+", metavar="PERSON_ID key=value")
    ap.add_argument("--threshold", type=float, default=None)
    a = ap.parse_args(argv)
    s = get_settings()
    store = PeopleStore(s.people_path, threshold=a.threshold or s.match_threshold)

    if a.remove:
        print("removed" if store.remove(a.remove) else "no such person")
        return
    if a.meta:
        pid, *kvs = a.meta
        if pid not in store.people:
            sys.exit(f"no such person {pid}")
        store.people[pid].meta.update(dict(kv.split("=", 1) for kv in kvs))
        store.save()
        print(store.people[pid].meta)
        return
    if a.from_dir or a.live:
        engine = FaceEngine(s.yunet_path, s.sface_path, s.detect_score, s.detect_max_side)
        if a.from_dir:
            if not a.from_dir.is_dir():
                sys.exit(f"{a.from_dir} is not a directory")
            summary = enroll_from_dir(a.from_dir, engine, store)
            print(f"\nenrolled from {a.from_dir} -> {s.people_path}")
            for pid, r in summary.items():
                print(f"  {pid:<14} used {r['used']:<3} skipped {len(r['skipped'])}")
                for fname, why in r["skipped"]:
                    print(f"      skip {fname}: {why}")
            a.check = True
        if a.live:
            enroll_live(a.live, engine, store, a.samples or s.enroll_samples)
    if a.list or not (a.from_dir or a.live or a.check):
        print(f"{s.people_path}:")
        for pid, p in store.people.items():
            kinds = {}
            for src in p.sources:
                k = src.split(":")[0]
                kinds[k] = kinds.get(k, 0) + 1
            print(f"  {pid:<14} {p.name:<16} {len(p.embeddings)} samples {kinds} {p.meta or ''}")
    if a.check:
        leave_one_out(store)


if __name__ == "__main__":
    main()
