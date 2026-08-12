import './styles.css';
import { api, ApiError } from './api';
import { RouterEventStream, type LinkStatus } from './events';
import { feedLineFor, store, type AppState } from './state';
import { isWebGLAvailable } from './scene/webgl';
import { TopologyScene } from './scene/topology-scene';
import { FallbackTopology } from './scene/fallback-topology';
import type { SceneCallbacks, TopologyRenderer } from './scene/renderer';
import { renderLogin } from './ui/login';
import { createKpis } from './ui/kpis';
import { providerDetail, providerList } from './ui/providers';
import { eventFeed } from './ui/feed';
import { createRegistry } from './ui/registry';
import { h } from './ui/dom';

const appEl = document.getElementById('app');
if (!appEl) throw new Error('#app mount point missing');
const mount: HTMLElement = appEl;

/* ── entry ──────────────────────────────────────────────────────────────── */

async function boot(): Promise<void> {
  try {
    const session = await api.session();
    if (session.authenticated) mountDashboard();
    else renderLogin(mount, mountDashboard);
  } catch {
    // Router unreachable — offer the gate anyway; login will surface the error.
    renderLogin(mount, mountDashboard);
  }
}

/* ── dashboard ────────────────────────────────────────────────────────────── */

function mountDashboard(): void {
  mount.setAttribute('aria-busy', 'false');

  // Panel bodies the renderers write into.
  const providersBody = h('div', { class: 'panel__body' });
  const detailBody = h('div', { class: 'panel__body' });
  const feedBody = h('div', { class: 'panel__body', attrs: { style: 'flex:0 0 42%' } });
  const detailTitle = h('div', { class: 'panel__title', text: 'Detail' });
  const providerCount = h('div', { class: 'eyebrow', text: '' });

  const kpis = createKpis();
  const registry = createRegistry();

  const sceneHost = h('div', { class: 'scene-host' });
  const linkPill = h('span', { class: 'pill' }, [h('span', { class: 'dot' }), h('b', { text: 'connecting' })]);
  const profileVal = h('b', { text: '—' });
  const profilePill = h('span', { class: 'pill' }, [document.createTextNode('profile '), profileVal]);

  const probeBtn = h('button', { class: 'btn', text: 'Probe health', type: 'button' });
  const resetBtn = h('button', { class: 'btn btn--danger', text: 'Reset cooldowns', type: 'button' });

  const shell = h('div', { class: 'shell' }, [
    h('header', { class: 'topbar' }, [
      h('div', { class: 'brand' }, [
        h('div', { class: 'brand__mark', text: '◇' }),
        h('div', {}, [
          h('div', { class: 'brand__name', html: 'LLM <b>Router</b>' }),
          h('div', { class: 'brand__sub', text: 'control plane' }),
        ]),
      ]),
      h('div', { class: 'topbar__spacer' }),
      profilePill,
      linkPill,
      h('button', { class: 'btn btn--gold', text: 'Registry', type: 'button', onClick: () => openRegistry() }),
      h('button', { class: 'btn btn--ghost', text: 'Logout', type: 'button', onClick: () => logout() }),
    ]),
    kpis.el,
    h('div', { class: 'stage' }, [
      sceneHost,
      h('section', { class: 'panel panel--left' }, [
        h('div', { class: 'panel__head' }, [h('div', { class: 'panel__title', text: 'Providers' }), providerCount]),
        providersBody,
        h('div', { class: 'panel__foot' }, [probeBtn, resetBtn]),
      ]),
      h('section', { class: 'panel panel--right' }, [
        h('div', { class: 'panel__head' }, [detailTitle, h('div', { class: 'eyebrow', text: 'live' })]),
        detailBody,
        h('div', { class: 'panel__head', attrs: { style: 'border-top:1px solid var(--hair-soft)' } }, [
          h('div', { class: 'panel__title', text: 'Live feed' }),
        ]),
        feedBody,
      ]),
      buildLegend(),
    ]),
  ]);

  mount.replaceChildren(shell, registry.el);

  /* renderers */
  const callbacks: SceneCallbacks = { onSelect: (id) => selectProvider(id), onHover: () => undefined };
  const renderer: TopologyRenderer = isWebGLAvailable()
    ? new TopologyScene(sceneHost, callbacks)
    : new FallbackTopology(sceneHost, callbacks);

  const renderProviders = providerList(providersBody, (id) => selectProvider(id));
  const renderDetail = providerDetail(detailBody, detailTitle);
  const renderFeed = eventFeed(feedBody);

  function selectProvider(id: string | null): void {
    const next = store.get().selectedProviderId === id ? null : id;
    store.select(next);
    renderer.select(next);
  }

  /* paint everything from a state snapshot */
  const paint = (s: AppState): void => {
    if (s.stats) {
      kpis.update(s.stats);
      profileVal.textContent = s.stats.currentProfile;
    }
    providerCount.textContent = `${s.providers.length} nodes`;
    renderProviders(s.providers, s.selectedProviderId);
    renderDetail(s.providers, s.selectedProviderId);
    renderFeed(s.feed);
  };
  store.subscribe(paint);
  // Keep the cooldown countdown ticking even during idle (no events).
  const ticker = window.setInterval(() => paint(store.get()), 1000);

  /* live stream */
  const stream = new RouterEventStream();
  stream.onStatus((status) => setLink(linkPill, status));
  stream.on('stats', (e) => store.patch({ stats: e.stats }));
  stream.on('request.route', (e) => renderer.routePulse(e.ladder));
  stream.on('request.attempt', (e) => renderer.attemptPulse(e.attempt.provider, e.attempt.status === 'success'));
  stream.on('request.fallback', (e) => renderer.fallbackPulse(e.from));
  stream.on('health.change', () => scheduleOverview());
  stream.on('model.disabled', () => void refreshRegistry());
  stream.onAny((event) => {
    const line = feedLineFor(event);
    if (line) store.pushFeed(line.kind, line.tag, line.message, 'at' in event ? event.at : Date.now());
  });
  stream.connect();

  /* data loading */
  let overviewTimer = 0;
  function scheduleOverview(): void {
    if (overviewTimer) return;
    overviewTimer = window.setTimeout(() => {
      overviewTimer = 0;
      void refreshOverview();
    }, 400);
  }

  async function refreshOverview(): Promise<void> {
    try {
      const o = await api.overview();
      store.patch({ stats: o.stats, providers: o.providers, topology: o.topology });
      renderer.setTopology(o.topology);
    } catch (e) {
      handleError(e);
    }
  }

  async function refreshRegistry(): Promise<void> {
    try {
      const [models, profiles, keys] = await Promise.all([api.models(), api.profiles(), api.keys()]);
      store.patch({ models: models.models, profiles: profiles.profiles, keys: keys.keys });
      registry.update({
        models: models.models,
        profiles: profiles.profiles,
        defaultProfile: profiles.defaultProfile,
        keys: keys.keys,
      });
    } catch (e) {
      handleError(e);
    }
  }

  function openRegistry(): void {
    registry.open();
    void refreshRegistry();
  }

  /* admin controls — server still enforces ADMIN_TOKEN on these */
  probeBtn.addEventListener('click', () => {
    probeBtn.disabled = true;
    probeBtn.textContent = 'Probing…';
    void api
      .probeHealth()
      .catch(handleError)
      .finally(() => {
        probeBtn.disabled = false;
        probeBtn.textContent = 'Probe health';
        void refreshOverview();
      });
  });
  resetBtn.addEventListener('click', () => {
    resetBtn.disabled = true;
    void api
      .resetHealth()
      .catch(handleError)
      .finally(() => {
        resetBtn.disabled = false;
        void refreshOverview();
      });
  });

  function logout(): void {
    window.clearInterval(ticker);
    window.clearInterval(poll);
    stream.close();
    renderer.dispose();
    void api
      .logout()
      .catch(() => undefined)
      .finally(() => renderLogin(mount, mountDashboard));
  }

  function handleError(e: unknown): void {
    if (e instanceof ApiError && e.status === 401) {
      window.clearInterval(ticker);
      window.clearInterval(poll);
      stream.close();
      renderer.dispose();
      renderLogin(mount, mountDashboard);
    }
  }

  // Initial load + a slow poll so latency/health stay fresh without traffic.
  void refreshOverview();
  void refreshRegistry();
  const poll = window.setInterval(() => void refreshOverview(), 8000);
}

/* ── small view helpers ───────────────────────────────────────────────────── */

function setLink(pill: HTMLElement, status: LinkStatus): void {
  const label = status === 'live' ? 'live' : status === 'reconnecting' ? 'reconnecting' : status === 'down' ? 'offline' : 'connecting';
  const b = pill.querySelector('b');
  if (b) b.textContent = label;
  pill.classList.toggle('pill--live', status === 'live');
  pill.classList.toggle('pill--down', status === 'down' || status === 'reconnecting');
}

function buildLegend(): HTMLElement {
  const items: Array<[string, string]> = [
    ['online', 'var(--h-online)'],
    ['degraded', 'var(--h-degraded)'],
    ['rate-limited', 'var(--h-rate)'],
    ['offline', 'var(--h-offline)'],
    ['disabled', 'var(--h-disabled)'],
  ];
  return h(
    'div',
    { class: 'scene-legend' },
    items.map(([label, color]) =>
      h('span', {}, [h('i', { attrs: { style: `background:${color}` } }), document.createTextNode(label)]),
    ),
  );
}

void boot();
