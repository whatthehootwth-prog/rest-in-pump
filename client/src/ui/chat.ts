import { CHAT_MAX, sanitizeChat } from '../../../shared/protocol.ts';

const MAX_LINES = 80;

/**
 * Bottom-left game chat. Messages are only those the server relayed (or real join/leave events);
 * history starts when you join — there is no stored backlog.
 */
export class ChatPanel {
  private readonly log = document.getElementById('chat-log') as HTMLOListElement;
  private readonly input = document.getElementById('chat-input') as HTMLInputElement;
  private readonly send: (text: string) => boolean;
  private connected = false;

  constructor(send: (text: string) => boolean) {
    this.send = send;
    const form = document.getElementById('chat-form') as HTMLFormElement;
    form.addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    this.input.addEventListener('focus', () => { this.input.placeholder = 'Type a message · Enter to send · Esc to close'; });
    this.input.addEventListener('blur', () => { this.input.placeholder = this.connected ? 'Press Enter to chat' : 'Chat is offline'; });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.input.value = ''; this.input.blur(); }
      e.stopPropagation();   // typing never moves the owl
    });
  }

  /** Enter (outside the chat) focuses the input and flashes it, so it is obvious where to type. */
  focus(): void {
    const form = this.input.form;
    if (form) { form.classList.remove('flash'); void form.offsetWidth; form.classList.add('flash'); }
    if (this.connected) this.input.focus();
  }

  setConnected(on: boolean): void {
    this.connected = on;
    this.input.disabled = !on;
    this.input.placeholder = on ? 'Press Enter to chat' : 'Chat is offline';
    if (!on && document.activeElement === this.input) this.input.blur();
  }

  message(name: string, text: string, me: boolean): void {
    const li = document.createElement('li');
    if (me) li.className = 'me';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = name;
    li.append(who, document.createTextNode(text));
    this.push(li);
  }

  system(text: string): void { this.line(text, 'sys'); }
  error(text: string): void { this.line(text, 'sys err'); }

  private line(text: string, cls: string) {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    this.push(li);
  }

  private push(li: HTMLLIElement) {
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 30;
    this.log.append(li);
    while (this.log.children.length > MAX_LINES) this.log.firstElementChild?.remove();
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }

  private submit() {
    const raw = this.input.value;
    if (!raw.trim()) { this.input.blur(); return; }
    const text = sanitizeChat(raw);
    if (!text) { this.error(`Messages can be up to ${CHAT_MAX} characters.`); return; }
    if (!this.send(text)) { this.error('Not connected — message not sent.'); return; }
    this.input.value = '';
    this.input.blur();
  }
}
