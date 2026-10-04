// Tells real speech apart from static/noise. Speech has quiet gaps (between words and at the
// ends) and a moderate zero-crossing rate; broken model output is a continuous hiss with a
// very high zero-crossing rate or almost no loudness variation.
export function checkSpeech(audio, sr = 24000) {
  const n = audio.length;
  if (!n) return { ok: false, reason: 'empty' };
  let crossings = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    const v = audio[i];
    if (!Number.isFinite(v)) return { ok: false, reason: 'invalid numbers' };
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (i && (audio[i - 1] >= 0) !== (v >= 0)) crossings++;
  }
  if (peak < 0.01) return { ok: false, reason: 'silence' };
  const zcr = crossings / n;

  const frame = Math.max(1, Math.round(sr * 0.02));
  const rms = [];
  for (let f = 0; f + frame <= n; f += frame) {
    let s = 0;
    for (let j = f; j < f + frame; j++) s += audio[j] * audio[j];
    rms.push(Math.sqrt(s / frame));
  }
  rms.sort((a, b) => a - b);
  const pct = (p) => rms[Math.min(rms.length - 1, Math.floor(p * rms.length))] || 0;
  const dynamics = (pct(0.9) + 1e-4) / (pct(0.1) + 1e-4);

  const ok = zcr < 0.3 && dynamics > 4;
  return { ok, zcr: +zcr.toFixed(3), dynamics: +dynamics.toFixed(1), reason: ok ? '' : 'sounds like noise' };
}
