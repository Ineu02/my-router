import { api, ApiError } from '../api';
import { h } from './dom';

/**
 * ADMIN_TOKEN gate.
 *
 * The token is posted once to `/api/admin/login`, which validates it and sets
 * an httpOnly session cookie; it is never stored in JS, localStorage, or the
 * URL. Every subsequent admin call rides that cookie. If the server reports
 * ADMIN_TOKEN isn't configured, we say so rather than letting the operator
 * guess why every attempt 401s.
 */
export function renderLogin(mount: HTMLElement, onSuccess: () => void): void {
  const input = h('input', {
    class: 'input',
    type: 'password',
    placeholder: 'ADMIN_TOKEN',
    ariaLabel: 'Admin token',
  });
  const err = h('div', { class: 'gate__err' });
  const btn = h('button', { class: 'btn btn--gold gate__btn', text: 'Authenticate', type: 'button' });

  let busy = false;
  const submit = (): void => {
    if (busy) return;
    const token = input.value.trim();
    if (!token) {
      err.textContent = 'Enter the admin token.';
      return;
    }
    busy = true;
    btn.textContent = 'Authenticating…';
    err.textContent = '';
    void api
      .login(token)
      .then(() => onSuccess())
      .catch((e: unknown) => {
        err.textContent =
          e instanceof ApiError ? e.message : 'Login failed — is the router reachable?';
      })
      .finally(() => {
        busy = false;
        btn.textContent = 'Authenticate';
      });
  };

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  const card = h('div', { class: 'gate__card' }, [
    h('div', { class: 'gate__mark', text: '◇' }),
    h('div', { class: 'gate__h', text: 'Control Plane Access' }),
    h('div', { class: 'gate__sub', text: 'Admin token required to view routing and health.' }),
    h('div', { class: 'field' }, [h('label', { text: 'Token' }), input]),
    err,
    btn,
    h('div', {
      class: 'gate__note',
      html: 'The token is exchanged for an httpOnly session cookie and never stored in the browser. Set <code>ADMIN_TOKEN</code> in the router <code>.env</code>.',
    }),
  ]);

  mount.replaceChildren(h('div', { class: 'gate' }, [card]));
  input.focus();
}
