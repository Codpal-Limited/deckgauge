import type { SuggestionOptions } from '@tiptap/suggestion';

export function buildMentionSuggestion(
  boardId: string,
  apiBaseUrl: string,
): Partial<SuggestionOptions> {
  return {
    char: '@',
    async items({ query }) {
      if (!query) return [];
      // R5.8: only users WITH BOARD ACCESS may be mentioned. This parameter used
      // to be accepted and thrown away (`void boardId`), so the picker offered
      // colleagues who would have received a notification pointing at a 403.
      const scope = boardId ? `&boardId=${encodeURIComponent(boardId)}` : '';
      const res = await fetch(
        `${apiBaseUrl}/users/search?q=${encodeURIComponent(query)}${scope}`,
      );
      if (!res.ok) return [];
      const users: Array<{ id: string; name: string }> = await res.json();
      return users.slice(0, 8).map((u) => ({ id: u.id, label: u.name }));
    },
    render() {
      let popup: HTMLElement | null = null;
      let selectedIndex = 0;
      let items: Array<{ id: string; label: string }> = [];
      let command: ((item: { id: string; label: string }) => void) | null = null;

      return {
        onStart(props) {
          popup = document.createElement('ul');
          popup.className =
            'absolute z-50 bg-white border rounded-lg shadow-lg text-sm overflow-hidden min-w-[160px]';
          items = props.items;
          command = props.command;
          selectedIndex = 0;
          renderList(popup, items, selectedIndex, props.command);
          document.body.appendChild(popup);
          positionPopup(popup, props.clientRect?.());
        },
        onUpdate(props) {
          items = props.items;
          command = props.command;
          selectedIndex = 0;
          if (popup) {
            renderList(popup, items, selectedIndex, props.command);
            positionPopup(popup, props.clientRect?.());
          }
        },
        onKeyDown(props) {
          if (!popup) return false;
          if (props.event.key === 'ArrowDown') {
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            if (popup && command) renderList(popup, items, selectedIndex, command);
            return true;
          }
          if (props.event.key === 'ArrowUp') {
            selectedIndex = Math.max(selectedIndex - 1, 0);
            if (popup && command) renderList(popup, items, selectedIndex, command);
            return true;
          }
          if (props.event.key === 'Enter') {
            const item = items[selectedIndex];
            if (command && item !== undefined) {
              command(item);
            }
            return true;
          }
          return false;
        },
        onExit() {
          popup?.remove();
          popup = null;
        },
      };
    },
  };
}

function renderList(
  el: HTMLElement,
  items: Array<{ id: string; label: string }>,
  selectedIdx: number,
  command: (item: { id: string; label: string }) => void,
) {
  el.innerHTML = items
    .map(
      (item, i) =>
        `<li class="px-3 py-2 cursor-pointer ${i === selectedIdx ? 'bg-blue-50' : 'hover:bg-gray-50'}" data-idx="${i}">${item.label}</li>`,
    )
    .join('');
  el.querySelectorAll('li').forEach((li, i) => {
    li.addEventListener('click', () => command(items[i]!));
  });
}

function positionPopup(el: HTMLElement, rect: DOMRect | null | undefined) {
  if (!rect) return;
  el.style.position = 'fixed';
  el.style.left = `${rect.left}px`;
  el.style.top = `${rect.bottom + 4}px`;
}
