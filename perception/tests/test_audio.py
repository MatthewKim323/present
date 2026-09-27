import numpy as np

from perception.audio import EnergyVAD, pcm16_to_float, resample


def tone(sec, amp, sr=16000):
    t = np.arange(int(sec * sr)) / sr
    return (amp * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def noise(sec, amp, rng, sr=16000):
    return (amp * rng.standard_normal(int(sec * sr))).astype(np.float32)


def test_vad_segments_speech_between_silence(rng):
    vad = EnergyVAD()
    audio = np.concatenate([noise(1.0, 0.001, rng), tone(1.2, 0.3), noise(1.5, 0.001, rng), tone(0.8, 0.2), noise(1.0, 0.001, rng)])
    segs = []
    for i in range(0, len(audio), 1600):  # 100ms chunks like the sim sends
        segs += vad.feed(audio[i : i + 1600], ts=0.0 if i == 0 else None)
    assert len(segs) == 2
    assert 1.1 < segs[0].duration_s < 2.2
    assert segs[0].rms_db > segs[1].rms_db
    assert 0.8 < segs[0].start_ts < 1.2


def test_vad_ignores_clicks(rng):
    vad = EnergyVAD()
    audio = np.concatenate([noise(1.0, 0.001, rng), tone(0.05, 0.5), noise(1.0, 0.001, rng)])
    assert vad.feed(audio, ts=0.0) == []


def test_pcm_and_resample():
    pcm = (np.array([0, 16384, -32768], dtype="<i2")).tobytes()
    assert np.allclose(pcm16_to_float(pcm), [0, 0.5, -1.0])
    assert len(resample(np.zeros(48000, np.float32), 48000, 16000)) == 16000
