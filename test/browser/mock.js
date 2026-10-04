// Stubs the Firefox WebExtension APIs so pages can be tested in Chromium.
(() => {
  const store = {};
  const listeners = [];
  window.__log = [];
  window.__msgListeners = listeners;
  const makePort = () => {
    const ls = [];
    const port = {
      onMessage: { addListener: (f) => ls.push(f) },
      onDisconnect: { addListener() {} },
      disconnect() {},
      postMessage(m) {
        window.__log.push(m);
        const emit = (x) => setTimeout(() => ls.forEach((f) => f(x)), 0);
        if (m.t === 'warmup') { emit({ t: 'model', state: 'downloading', loaded: 30e6, total: 92e6 }); setTimeout(() => emit({ t: 'model', state: 'ready', engine: 'helper', device: 'native-cpu', helper: 'installed', workers: 1 }), 200); }
        if (m.t === 'play') {
          emit({ t: 'waiting', id: m.id });
          setTimeout(() => emit({ t: 'start', id: m.id }), 150);
          if (!window.__noAutoEnd) setTimeout(() => emit({ t: 'end', id: m.id }), 400);
        }
      },
    };
    return port;
  };
  window.browser = {
    runtime: {
      getURL: (p) => location.origin + '/' + p,
      connect: makePort,
      sendMessage: async () => {},
      onMessage: { addListener: (f) => listeners.push(f) },
    },
    storage: { local: {
      get: async (d) => ({ ...d, ...store }),
      set: async (o) => Object.assign(store, o),
    } },
    tabs: { create() {} },
  };
})();
