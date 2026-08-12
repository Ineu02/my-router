import type { FeedEntry } from '../state';
import { clear, fmtClock, h } from './dom';

/**
 * Live routing/fallback feed — renders the store's rolling event list into a
 * caller-owned body. Each line is tagged (route / fallback / ok / failed /
 * health) and colour-coded via the `ev--*` classes. Newest first.
 */
export function eventFeed(body: HTMLElement): (feed: FeedEntry[]) => void {
  return (feed) => {
    clear(body);
    if (feed.length === 0) {
      body.append(h('div', { class: 'feed__empty', text: 'Awaiting traffic… routing activity appears here live.' }));
      return;
    }
    const list = h('div', { class: 'feed' });
    for (const e of feed) {
      list.append(
        h('div', { class: `ev ev--${e.kind}` }, [
          h('span', { class: 'ev__t', text: fmtClock(e.at) }),
          h('span', { class: 'ev__msg', text: e.message }),
          h('span', { class: 'ev__tag', text: e.tag }),
        ]),
      );
    }
    body.append(list);
  };
}
