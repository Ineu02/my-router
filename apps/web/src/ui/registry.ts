import type { ModelRow, ProfileRow, PublicRouterKey } from '../api';
import { clear, fmtAgo, fmtNum, h } from './dom';

type Tab = 'models' | 'profiles' | 'keys';

interface RegistryData {
  models: ModelRow[];
  profiles: ProfileRow[];
  defaultProfile: string;
  keys: PublicRouterKey[];
}

/**
 * Slide-over registry: the model catalogue, routing profiles (the fallback
 * ladders), and router client keys. Read-only and masked — key material is
 * never present in these responses, so there is nothing here to leak.
 */
export function createRegistry(): {
  el: HTMLElement;
  open: () => void;
  close: () => void;
  update: (data: RegistryData) => void;
} {
  let tab: Tab = 'models';
  let latest: RegistryData = { models: [], profiles: [], defaultProfile: '', keys: [] };

  const bodyEl = h('div', { class: 'drawer__body' });
  const tabsEl = h('div', { class: 'tabs' });
  const overlay = h('div', { class: 'drawer' }, [
    h('div', { class: 'drawer__panel' }, [
      h('div', { class: 'drawer__head' }, [
        h('div', { class: 'panel__title', text: 'Registry' }),
        tabsEl,
        h('button', { class: 'btn btn--ghost', text: 'Close ✕', type: 'button', onClick: () => close() }),
      ]),
      bodyEl,
    ]),
  ]);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'models', label: 'Models' },
    { id: 'profiles', label: 'Profiles' },
    { id: 'keys', label: 'Client Keys' },
  ];

  for (const t of TABS) {
    tabsEl.append(
      h('button', {
        class: 'tab',
        text: t.label,
        type: 'button',
        ariaSelected: t.id === tab,
        onClick: () => {
          tab = t.id;
          syncTabs();
          render();
        },
      }),
    );
  }

  const syncTabs = (): void => {
    [...tabsEl.children].forEach((c, i) => {
      const t = TABS[i];
      if (t) c.setAttribute('aria-selected', String(t.id === tab));
    });
  };

  const table = (head: string[], rows: HTMLElement[]): HTMLElement => {
    const thead = h('tr', {}, head.map((label) => h('th', { text: label })));
    const tbody = h('tbody', {}, rows);
    return h('table', { class: 'reg' }, [h('thead', {}, [thead]), tbody]);
  };

  const render = (): void => {
    clear(bodyEl);
    if (tab === 'models') bodyEl.append(renderModels(latest.models));
    else if (tab === 'profiles') bodyEl.append(renderProfiles(latest.profiles, latest.defaultProfile));
    else bodyEl.append(renderKeys(latest.keys));
  };

  const renderModels = (models: ModelRow[]): HTMLElement => {
    if (models.length === 0) return h('div', { class: 'feed__empty', text: 'No models registered.' });
    const rows = models.map((m) =>
      h('tr', {}, [
        h('td', {}, [h('b', { text: m.displayName }), document.createTextNode(` ${m.id}`)]),
        h('td', { text: m.provider }),
        h('td', { text: m.model }),
        h('td', {}, m.capabilities.map((c) => h('span', { class: 'chip', text: c }))),
        h('td', { text: String(m.priority) }),
        h('td', {
          class: m.enabled && m.providerEnabled ? 'badge-on' : 'badge-off',
          text: !m.enabled ? 'disabled' : m.providerEnabled ? 'enabled' : 'provider off',
        }),
      ]),
    );
    return table(['Model', 'Provider', 'Upstream', 'Capabilities', 'Priority', 'State'], rows);
  };

  const renderProfiles = (profiles: ProfileRow[], def: string): HTMLElement => {
    if (profiles.length === 0) return h('div', { class: 'feed__empty', text: 'No routing profiles.' });
    const rows = profiles.map((p) => {
      const ladder = p.ladder.map((l) => `${l.provider ?? '?'}/${l.model}`).join('  ▸  ') || '—';
      return h('tr', {}, [
        h('td', {}, [
          h('b', { text: p.displayName }),
          document.createTextNode(` ${p.id}`),
          ...(p.id === def ? [h('span', { class: 'chip badge-on', text: 'default' })] : []),
        ]),
        h('td', { text: String(p.ladder.length) }),
        h('td', { text: ladder }),
        h('td', { class: p.enabled ? 'badge-on' : 'badge-off', text: p.enabled ? 'enabled' : 'disabled' }),
      ]);
    });
    return table(['Profile', 'Hops', 'Fallback ladder', 'State'], rows);
  };

  const renderKeys = (keys: PublicRouterKey[]): HTMLElement => {
    if (keys.length === 0) return h('div', { class: 'feed__empty', text: 'No client keys issued.' });
    const rows = keys.map((k) => {
      const revoked = k.revokedAt !== null;
      const usage = k.usageLimit === null ? `${fmtNum(k.usageCount)}` : `${fmtNum(k.usageCount)}/${fmtNum(k.usageLimit)}`;
      return h('tr', {}, [
        h('td', {}, [h('b', { text: k.name })]),
        h('td', { text: k.maskedKey }),
        h('td', { text: usage }),
        h('td', { text: fmtAgo(k.lastUsedAt) }),
        h('td', {
          class: revoked ? 'badge-off' : k.enabled ? 'badge-on' : 'badge-off',
          text: revoked ? 'revoked' : k.enabled ? 'active' : 'disabled',
        }),
      ]);
    });
    return table(['Name', 'Key', 'Usage', 'Last used', 'State'], rows);
  };

  const open = (): void => overlay.classList.add('open');
  const close = (): void => overlay.classList.remove('open');
  const update = (data: RegistryData): void => {
    latest = data;
    if (overlay.classList.contains('open')) render();
  };

  render();
  return { el: overlay, open, close, update };
}
