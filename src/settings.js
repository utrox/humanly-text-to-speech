// Shared settings and voice list.
export const VOICES = [
  { id: 'af_heart',   name: 'Heart (US, female)' },
  { id: 'af_bella',   name: 'Bella (US, female)' },
  { id: 'af_nicole',  name: 'Nicole (US, female, soft)' },
  { id: 'af_aoede',   name: 'Aoede (US, female)' },
  { id: 'af_kore',    name: 'Kore (US, female)' },
  { id: 'af_sarah',   name: 'Sarah (US, female)' },
  { id: 'af_nova',    name: 'Nova (US, female)' },
  { id: 'am_michael', name: 'Michael (US, male)' },
  { id: 'am_fenrir',  name: 'Fenrir (US, male)' },
  { id: 'am_puck',    name: 'Puck (US, male)' },
  { id: 'am_echo',    name: 'Echo (US, male)' },
  { id: 'bf_emma',    name: 'Emma (UK, female)' },
  { id: 'bf_isabella',name: 'Isabella (UK, female)' },
  { id: 'bm_george',  name: 'George (UK, male)' },
  { id: 'bm_fable',   name: 'Fable (UK, male)' },
  { id: 'bm_lewis',   name: 'Lewis (UK, male)' },
];

export const DEFAULTS = {
  voice: 'af_heart',
  speed: 1.0,
  mainOnly: true,
  autoScroll: true,
  interceptPdf: true,
  useGpu: true,
  engine: 'auto',      // auto | helper | system | browser
  systemVoice: '',
};

export async function getSettings() {
  const s = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

export function setSettings(patch) {
  return browser.storage.local.set(patch);
}
