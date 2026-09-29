"""Synthesize the 30 s background track for the PickleScout intro -> public/music.wav.

Pure numpy; no samples, so there is no licensing question.
120 BPM, one bar = 2 s, 15 bars. Arrangement follows src/timeline.ts:
  bars 0-1   intro      pad only
  bars 2-3   input      + kick, bass
  bars 4-12  pipeline   + hats, arpeggio (explore -> package)
  bars 13-14 outro      drums out, pad + arp tail, fade
"""

import wave
from pathlib import Path

import numpy as np

SR = 48_000
BPM = 120
BEAT = 60 / BPM
BAR = 4 * BEAT
BARS = 15
N = int(BARS * BAR * SR)
t_all = np.arange(N) / SR
rng = np.random.default_rng(7)

# A minor, uplifting loop: Am - F - C - G. MIDI note numbers.
CHORDS = [
    [57, 60, 64],  # Am
    [53, 57, 60],  # F
    [48, 52, 55],  # C
    [55, 59, 62],  # G
]


def hz(midi: float) -> float:
    return 440.0 * 2 ** ((midi - 69) / 12)


def place(buf: np.ndarray, start_s: float, sig: np.ndarray) -> None:
    i = int(start_s * SR)
    if i >= len(buf):
        return
    end = min(len(buf), i + len(sig))
    buf[i:end] += sig[: end - i]


def adsr(n: int, a: float, r: float) -> np.ndarray:
    env = np.ones(n)
    na, nr = int(a * SR), int(r * SR)
    env[:na] = np.linspace(0, 1, na)
    env[n - nr :] *= np.linspace(1, 0, nr)
    return env


# --- pad: detuned additive saw, soft harmonics, slow swell -------------------
pad = np.zeros(N)
for bar in range(BARS):
    chord = CHORDS[bar % 4]
    n = int(BAR * SR * 1.15)  # overlap next bar slightly for a legato wash
    t = np.arange(n) / SR
    sig = np.zeros(n)
    for note in chord + [chord[0] - 12]:
        for detune in (-0.08, 0.08):
            f = hz(note + detune)
            for h in range(1, 7):
                sig += np.sin(2 * np.pi * f * h * t + rng.uniform(0, 6.28)) / (h**1.6)
    place(pad, bar * BAR, sig * adsr(n, 0.6, 0.9))
pad /= np.abs(pad).max()

# --- sidechain envelope (ducks pad + bass on each kick) ----------------------
duck = np.ones(N)
drum_bars = range(2, 13)
kick_times = [b * BAR + k * BEAT for b in drum_bars for k in range(4)]
for kt in kick_times:
    i = int(kt * SR)
    n = int(BEAT * SR)
    shape = 1 - 0.55 * np.exp(-np.arange(n) / (0.09 * SR))
    duck[i : i + n] = np.minimum(duck[i : i + n], shape[: len(duck[i : i + n])])

# --- kick: pitch-dropping sine ----------------------------------------------
kick = np.zeros(N)
kn = int(0.35 * SR)
kt_ = np.arange(kn) / SR
k_freq = 45 + 110 * np.exp(-kt_ / 0.035)
k_sig = np.sin(2 * np.pi * np.cumsum(k_freq) / SR) * np.exp(-kt_ / 0.12)
for kt in kick_times:
    place(kick, kt, k_sig)

# --- bass: eighth-note root pulse -------------------------------------------
bass = np.zeros(N)
bn = int(BEAT / 2 * SR)
bt = np.arange(bn) / SR
for bar in range(2, 13):
    root = CHORDS[bar % 4][0] % 12 + 36  # same pitch class, octave 2 (65-110 Hz)
    f = hz(root)
    note = (np.sin(2 * np.pi * f * bt) + 0.3 * np.sin(4 * np.pi * f * bt)) * adsr(bn, 0.005, 0.08)
    for e in range(8):
        place(bass, bar * BAR + e * BEAT / 2, note)

# --- hats: high-passed noise on off-beats -----------------------------------
hats = np.zeros(N)
hn = int(0.05 * SR)
for bar in range(4, 13):
    for k in range(4):
        noise = np.diff(rng.standard_normal(hn + 1)) * np.exp(-np.arange(hn) / (0.012 * SR))
        place(hats, bar * BAR + k * BEAT + BEAT / 2, noise)

# --- arpeggio: plucked chord tones in 16ths ---------------------------------
arp = np.zeros(N)
an = int(0.4 * SR)
at = np.arange(an) / SR
pattern = [0, 1, 2, 1, 2, 3, 2, 1] * 2
for bar in range(4, 15):
    chord = CHORDS[bar % 4]
    tones = [chord[0] + 12, chord[1] + 12, chord[2] + 12, chord[0] + 24]
    for s, idx in enumerate(pattern):
        f = hz(tones[idx])
        note = (np.sin(2 * np.pi * f * at) + 0.25 * np.sin(6 * np.pi * f * at)) * np.exp(-at / 0.09)
        place(arp, bar * BAR + s * BEAT / 4, note * (0.8 if s % 4 else 1.0))

# --- mix ----------------------------------------------------------------------
mono_dry = 0.34 * pad * duck + 0.9 * kick + 0.32 * bass * duck + 0.05 * hats
arp_r = np.roll(arp, int(BEAT * 0.75 * SR))  # dotted-eighth echo on the right for width

left = mono_dry + 0.16 * arp + 0.07 * arp_r
right = mono_dry + 0.10 * arp + 0.13 * arp_r

# Simple convolution reverb: decaying noise impulse, different per channel.
ir_n = int(1.6 * SR)
ir_t = np.arange(ir_n) / SR


def reverb(x: np.ndarray, seed: int) -> np.ndarray:
    ir = np.random.default_rng(seed).standard_normal(ir_n) * np.exp(-ir_t / 0.35)
    size = 1 << int(np.ceil(np.log2(len(x) + ir_n)))
    wet = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]
    return wet / np.abs(wet).max()


left = left + 0.12 * reverb(left, 1)
right = right + 0.12 * reverb(right, 2)

# Fade in over 0.4 s, fade out over the last 2.5 s (outro).
fade = np.ones(N)
fade[: int(0.4 * SR)] = np.linspace(0, 1, int(0.4 * SR))
fo = int(2.5 * SR)
fade[-fo:] = np.linspace(1, 0, fo) ** 1.5

stereo = np.stack([left, right], axis=1) * fade[:, None]
stereo = np.tanh(1.2 * stereo / np.abs(stereo).max())
stereo *= 0.45 / np.abs(stereo).max()  # peak ~ -7 dBFS -> about -16 LUFS, a background level

out = Path(__file__).resolve().parent.parent / "public" / "music.wav"
pcm = (stereo * 32767).astype("<i2")

with wave.open(str(out), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print(f"wrote {out} ({len(pcm) / SR:.2f}s)")
