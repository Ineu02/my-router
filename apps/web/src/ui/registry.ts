import type { CodexAccount, ModelRow, ProfileRow, PublicRouterKey } from '../api';
import { api, ApiError } from '../api';
import { clear, fmtAgo, fmtNum, h } from './dom';

type Tab = 'models' | 'profiles' | 'keys' | 'connections';

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
    { id: 'connections', label: 'Connections' },
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
    else if (tab === 'keys') bodyEl.append(renderKeys(latest.keys));
    else bodyEl.append(renderConnections());
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

  /* ── ChatGPT / Codex OAuth connections ───────────────────────────────── */
  // Self-fetching: this tab pulls its own state and drives the connect /
  // disconnect actions. Every value shown is masked + status only — the server
  // never serialises a token, so there is nothing here to leak.
  let codexAccounts: CodexAccount[] = [];
  let codexEnabled = true;
  let codexLoaded = false;
  let codexNote = '';

  const refreshCodex = async (): Promise<void> => {
    try {
      const res = await api.codexAccounts();
      codexAccounts = res.accounts;
      codexEnabled = true;
    } catch (e) {
      // A 404 means OAuth is not enabled on this server; anything else is a
      // real error worth showing.
      if (e instanceof ApiError && e.status === 404) codexEnabled = false;
      else codexNote = e instanceof Error ? e.message : 'Failed to load accounts.';
      codexAccounts = [];
    } finally {
      codexLoaded = true;
      if (tab === 'connections' && overlay.classList.contains('open')) render();
    }
  };

  const connectCodex = async (btn: HTMLButtonElement): Promise<void> => {
    btn.disabled = true;
    btn.textContent = 'Opening…';
    try {
      const { authorizeUrl } = await api.codexConnect();
      // The operator approves in the real OpenAI login tab; the router's
      // loopback callback finishes the flow and creates the credential.
      window.open(authorizeUrl, '_blank', 'noopener');
      codexNote = 'Approve access in the opened tab, then Refresh.';
    } catch (e) {
      codexNote = e instanceof Error ? e.message : 'Could not start the connection.';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Connect account';
      render();
    }
  };

  const disconnectCodex = async (id: string): Promise<void> => {
    try {
      await api.codexDisconnect(id);
    } catch (e) {
      codexNote = e instanceof Error ? e.message : 'Disconnect failed.';
    }
    await refreshCodex();
  };

  const renderConnections = (): HTMLElement => {
    const wrap = h('div', { class: 'conn' });

    const connectBtn = h('button', {
      class: 'btn btn--gold',
      text: 'Connect account',
      type: 'button',
    });
    connectBtn.addEventListener('click', () => void connectCodex(connectBtn));

    const refreshBtn = h('button', {
      class: 'btn btn--ghost',
      text: 'Refresh',
      type: 'button',
      onClick: () => void refreshCodex(),
    });

    wrap.append(
      h('div', { class: 'conn__head' }, [
        h('div', {}, [
          h('div', { class: 'panel__title', text: 'ChatGPT / Codex accounts' }),
          h('div', {
            class: 'eyebrow',
            text: 'OAuth (PKCE). Tokens are stored encrypted and never shown here.',
          }),
        ]),
        h('div', { class: 'conn__actions' }, codexEnabled ? [connectBtn, refreshBtn] : []),
      ]),
    );

    if (codexNote) wrap.append(h('div', { class: 'conn__note', text: codexNote }));

    if (!codexEnabled) {
      wrap.append(
        h('div', {
          class: 'feed__empty',
          text: 'Codex OAuth is not enabled on this server. Set CODEX_OAUTH_ENABLED=true and restart.',
        }),
      );
      return wrap;
    }

    if (!codexLoaded) {
      wrap.append(h('div', { class: 'feed__empty', text: 'Loading accounts…' }));
      void refreshCodex();
      return wrap;
    }

    if (codexAccounts.length === 0) {
      wrap.append(
        h('div', { class: 'feed__empty', text: 'No accounts connected. Connect one to route Codex traffic.' }),
      );
      return wrap;
    }

    const rows = codexAccounts.map((a) => {
      const status = !a.enabled
        ? 'disabled'
        : a.health
          ? a.health.status
          : a.expired
            ? 'expired'
            : 'connected';
      const disc = h('button', {
        class: 'btn btn--danger',
        text: 'Disconnect',
        type: 'button',
        onClick: () => void disconnectCodex(a.credentialId),
      });
      return h('tr', {}, [
        h('td', {}, [
          h('b', { text: a.email ?? a.accountId ?? a.label }),
          document.createTextNode(` ${a.accountId ?? ''}`),
        ]),
        h('td', { text: a.maskedKey }),
        h('td', { text: a.expiresAt ? fmtAgo(a.expiresAt) : '—' }),
        h('td', { class: a.enabled && !a.expired ? 'badge-on' : 'badge-off', text: status }),
        h('td', {}, [disc]),
      ]);
    });

    wrap.append(table(['Account', 'Ref', 'Token expiry', 'Status', ''], rows));
    return wrap;
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
