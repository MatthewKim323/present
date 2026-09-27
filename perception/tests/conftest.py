import numpy as np
import pytest


def unit(v):
    v = np.asarray(v, dtype=np.float32)
    return v / np.linalg.norm(v)


@pytest.fixture
def rng():
    return np.random.default_rng(0)


def person_embs(rng, center, n=5, noise=0.15):
    return [unit(center + noise * rng.standard_normal(128)) for _ in range(n)]
