import numpy as np

from conftest import person_embs, unit
from perception.people import PeopleStore, score_against


def test_match_enrolled_and_reject_unknown(rng, tmp_path):
    alex_c, sam_c, stranger_c = (rng.standard_normal(128) for _ in range(3))
    store = PeopleStore(tmp_path / "people.json", threshold=0.4)
    store.add("Alex", person_embs(rng, alex_c))
    store.add("Sam", person_embs(rng, sam_c))

    pid, name, score = store.match(unit(alex_c + 0.15 * rng.standard_normal(128)))
    assert (pid, name) == ("alex", "Alex") and score > 0.4
    pid, name, score = store.match(unit(stranger_c))
    assert pid is None and name is None and score < 0.4


def test_persistence_roundtrip(rng, tmp_path):
    p = tmp_path / "people.json"
    store = PeopleStore(p)
    store.add("Alex Chen", person_embs(rng, rng.standard_normal(128), n=3))
    again = PeopleStore(p)
    assert list(again.people) == ["alex-chen"]
    assert again.people["alex-chen"].name == "Alex Chen"
    assert len(again.people["alex-chen"].embeddings) == 3
    assert again.people["alex-chen"].sources == ["live"] * 3


def test_replace_source_keeps_live(rng, tmp_path):
    store = PeopleStore(tmp_path / "p.json")
    c = rng.standard_normal(128)
    store.add("Matthew", person_embs(rng, c, n=2), src="live", save=False)
    store.replace_source("Matthew", person_embs(rng, c, n=3), ["photo:a", "photo:b", "photo:c"], prefix="photo:")
    store.replace_source("Matthew", person_embs(rng, c, n=1), ["photo:a"], prefix="photo:")
    assert store.people["matthew"].sources == ["live", "live", "photo:a"]


def test_score_top_k_mean():
    e = unit(np.ones(128))
    gallery = [e, e, -e]
    assert abs(score_against(e, gallery, k=2) - 1.0) < 1e-5
    assert score_against(e, []) == -1.0
