/**
 * Run a pairing view's script the way the pairing container does, with a DOM
 * small enough to fit in this file.
 *
 * This exists because of a bug that shipped: `ends.html` was generated with its
 * own boot preamble (`var root` / `data-booted`) while the SHARED
 * `stabiliseScrollbar()` helper it also carried reads `__root` by name. The view
 * threw `ReferenceError: __root is not defined` before it ever asked the driver
 * for its data — so it rendered its static markup, then nothing, with no error on
 * screen because the `.catch` was never reached.
 *
 * Every check that existed passed: the file was byte-identical to its repair
 * copy, its helpers matched the other views', its locale keys resolved, and
 * `new Function(script)` parsed it. Nothing EXECUTED it.
 *
 * Deliberately not jsdom. What is needed to catch that class of bug is the DOM
 * the views actually touch — `getElementById`, `createElement`, `appendChild`,
 * `addEventListener`, `dataset`, `style`, `textContent` — and a real dependency
 * for it would be the only heavyweight one in the repo, in a project whose whole
 * test story is `node:test` and no framework.
 */

interface FakeNode {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  type: string;
  readonly children: FakeNode[];
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string>;
  readonly attributes: Record<string, string>;
  readonly listeners: Record<string, Array<(event: unknown) => void>>;
  parentElement: FakeNode | null;
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(name: string, fn: (event: unknown) => void): void;
  querySelector(selector: string): FakeNode | null;
  readonly firstChild: FakeNode | null;
  /** Every node beneath this one, this one included. */
  descendants(): FakeNode[];
}

function makeNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName: tagName.toLowerCase(),
    id: '',
    className: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    type: '',
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    listeners: {},
    parentElement: null,

    appendChild(child) {
      child.parentElement = node;
      node.children.push(child);
      return child;
    },
    removeChild(child) {
      const at = node.children.indexOf(child);
      if (at >= 0) node.children.splice(at, 1);
      child.parentElement = null;
      return child;
    },
    setAttribute(name, value) {
      node.attributes[name] = value;
      if (name === 'id') node.id = value;
      if (name === 'class') node.className = value;
    },
    getAttribute(name) {
      if (name === 'id') return node.id || null;
      if (name === 'class') return node.className || null;
      return node.attributes[name] ?? null;
    },
    addEventListener(name, fn) {
      (node.listeners[name] ??= []).push(fn);
    },
    querySelector(selector) {
      // Only the two forms the views use: `[data-role="x"]` and `.class`.
      const role = /^\[data-role="([^"]+)"\]$/.exec(selector);
      const cls = /^\.([\w-]+)$/.exec(selector);
      return node.descendants().find(candidate => {
        if (role) return candidate.attributes['data-role'] === role[1];
        if (cls) return candidate.className.split(/\s+/).includes(cls[1]!);
        return false;
      }) ?? null;
    },
    get firstChild() {
      return node.children[0] ?? null;
    },
    descendants() {
      const found: FakeNode[] = [node];
      for (const child of node.children) found.push(...child.descendants());
      return found;
    },
  };
  return node;
}

/**
 * Parse just enough of a view's markup to build its element tree.
 *
 * Tags, ids, classes and `data-*` attributes — which is what the scripts address
 * elements by. Text content is ignored: every string a view shows comes from
 * `Homey.__` at runtime, so the markup's own text is empty anyway.
 */
function parseBody(html: string, root: FakeNode): void {
  const body = html.slice(html.indexOf('<div class="wrap"'));
  const stack = [root];
  const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  const VOID = new Set(['input', 'br', 'img', 'hr', 'line', 'polyline', 'path', 'circle', 'rect']);

  let match: RegExpExecArray | null;
  let first = true;
  while ((match = tag.exec(body)) !== null) {
    const [, closing, name, attrs, selfClosing] = match;
    if (name!.toLowerCase() === 'script') break;

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    // The root element is the one already on the stack.
    if (first) {
      first = false;
      applyAttrs(root, attrs ?? '');
      continue;
    }

    const node = makeNode(name!);
    applyAttrs(node, attrs ?? '');
    stack[stack.length - 1]!.appendChild(node);
    if (!selfClosing && !VOID.has(name!.toLowerCase())) stack.push(node);
  }
}

function applyAttrs(node: FakeNode, attrs: string): void {
  for (const [, name, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
    node.setAttribute(name!, value!);
    if (name!.startsWith('data-')) {
      const key = name!.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
      node.dataset[key] = value!;
    }
    if (name === 'type') node.type = value!;
    if (name === 'style') {
      for (const rule of value!.split(';')) {
        const [property, setting] = rule.split(':');
        if (property && setting) {
          node.style[property.trim().replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = setting.trim();
        }
      }
    }
  }
}

export interface ViewRun {
  /** The view's root element, after its script has run. */
  root: FakeNode;
  /** Every `emit()` the view made, in order. */
  emitted: Array<{ event: string; data: unknown }>;
  /** Anything the script threw, which is the whole point of this harness. */
  error: unknown;
  byId(id: string): FakeNode | null;
  /** Fire a listener the view registered, as the container would. */
  fire(node: FakeNode, event: string, payload?: Record<string, unknown>): void;
  /** Let the view's promises settle. */
  settle(): Promise<void>;
}

export interface ViewOptions {
  /** What each `emit(event)` resolves to. An absent event rejects. */
  respond?: Record<string, unknown>;
  /** Locale lookups. Missing keys come back as the key, which is visible. */
  translate?: (key: string, tokens?: Record<string, unknown>) => string;
}

/**
 * Load a pairing view, run its script, and hand back what happened.
 *
 * The script is executed with `new Function`, not `eval`, so it cannot reach this
 * module's scope — it sees exactly the globals named below and nothing else,
 * which is a fair approximation of a webview.
 */
export function runPairView(html: string, options: ViewOptions = {}): ViewRun {
  const root = makeNode('div');
  parseBody(html, root);

  const byId = (id: string) => root.descendants().find(node => node.id === id) ?? null;
  const emitted: ViewRun['emitted'] = [];

  const homey = {
    __: options.translate ?? ((key: string) => key),
    // The container's Homey has this; every view calls it once at boot.
    ready: () => undefined,
    emit: (event: string, data: unknown) => {
      emitted.push({ event, data });
      const responses = options.respond ?? {};
      return Object.prototype.hasOwnProperty.call(responses, event)
        ? Promise.resolve(responses[event])
        : Promise.reject(new Error(`no stub for "${event}"`));
    },
    done: () => { /* the container closes the session */ },
    createDevice: async (device: unknown) => device,
  };

  const document = {
    getElementById: byId,
    createElement: makeNode,
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createTextNode: (text: string) => {
      const node = makeNode('#text');
      node.textContent = text;
      return node;
    },
    documentElement: makeNode('html'),
    // `insertAdjacentHTML` is the poller's give-up path: a view that never finds
    // Homey says so in the container's own document rather than staying blank.
    body: Object.assign(makeNode('body'), { insertAdjacentHTML: () => undefined }),
    querySelectorAll: (selector: string) => {
      const cls = /^\.([\w-]+)$/.exec(selector);
      return root.descendants().filter(node => (cls
        ? node.className.split(/\s+/).includes(cls[1]!)
        : node.tagName === selector.toLowerCase()));
    },
  };

  // `CSS` is referenced BOTH ways by the shared helper — `window.CSS && CSS.supports`
  // — so the bare global has to exist too, or the guard passes and the call throws.
  const css = { supports: () => true };
  /**
   * `window.Homey` is how a view actually starts.
   *
   * The container calls `onHomeyReady` once at ITS page load, long before a
   * view's script exists, so every view also polls `window.Homey` and boots
   * itself the moment it appears. Putting it here is what makes the harness run
   * the same path the device does — without it the views load and simply sit
   * there, which is indistinguishable from the bug this harness exists to catch.
   */
  const window: Record<string, unknown> = { CSS: css };

  const script = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('the view has no <script>');

  window.Homey = homey;

  let error: unknown = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function(
      'document', 'window', 'Homey', 'CSS',
      'getComputedStyle', 'setTimeout', 'clearTimeout', 'console',
      script,
    );
    run(
      document, window, homey, css,
      () => ({ overflowY: 'visible' }),
      // Timers are inert: `emit()` arms a 20 s timeout it always clears, and a
      // real one would keep the test process alive.
      () => 0,
      () => undefined,
      { log: () => undefined, error: () => undefined },
    );
  } catch (thrown) {
    error = thrown;
  }

  return {
    root,
    emitted,
    error,
    byId,
    fire(node, event, payload = {}) {
      for (const listener of node.listeners[event] ?? []) {
        listener({ target: node, ...payload });
      }
    },
    async settle() {
      for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
    },
  };
}
