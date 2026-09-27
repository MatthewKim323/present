from perception.tracker import Tracker, centroid_dist, iou


def test_iou_basic():
    assert iou((0, 0, 10, 10), (0, 0, 10, 10)) == 1.0
    assert iou((0, 0, 10, 10), (20, 20, 5, 5)) == 0.0
    assert abs(iou((0, 0, 10, 10), (5, 0, 10, 10)) - 50 / 150) < 1e-9


def test_stable_ids_across_motion():
    tr = Tracker(max_age_s=1.0)
    a, _ = tr.update([(100, 100, 50, 50), (400, 100, 50, 50)], 0.0)
    ids = [t.track_id for t, _ in a]
    for i in range(1, 10):
        a, exp = tr.update([(100 + 4 * i, 100, 50, 50), (400 - 4 * i, 100, 50, 50)], 0.1 * i)
        assert [t.track_id for t, _ in a] == ids
        assert not exp


def test_fast_motion_uses_centroid_fallback():
    tr = Tracker()
    (t0, _), = tr.update([(100, 100, 50, 50)], 0.0)[0]
    (t1, _), = tr.update([(130, 100, 50, 50)], 0.1)[0]  # IoU < 0.25 but close
    assert t1.track_id == t0.track_id


def test_new_track_far_away_and_expiry():
    tr = Tracker(max_age_s=0.5)
    (a, _), = tr.update([(0, 0, 50, 50)], 0.0)[0]
    assigned, _ = tr.update([(0, 0, 50, 50), (600, 400, 50, 50)], 0.1)
    assert len({t.track_id for t, _ in assigned}) == 2
    _, expired = tr.update([(600, 400, 50, 50)], 1.0)
    assert [t.track_id for t in expired] == [a.track_id]
    assert a.track_id not in tr.tracks


def test_expire_without_frames():
    tr = Tracker(max_age_s=0.5)
    tr.update([(0, 0, 50, 50)], 0.0)
    assert tr.expire(0.3) == []
    assert len(tr.expire(1.0)) == 1


def test_centroid_dist_scale_invariant():
    assert abs(centroid_dist((0, 0, 10, 10), (5, 0, 10, 10)) - 0.5) < 1e-9
