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

export interface FakeNode {
  tagName: string;
  id: string;
  className: string;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  selected: boolean;
  /** `<details>`. The mapping screen opens a collapsed section to show a note. */
  open: boolean;
  type: string;
  /** Set to reparse this node's children. Reading it is refused — see below. */
  innerHTML: string;
  readonly children: FakeNode[];
  readonly style: Record<string, string>;
  readonly dataset: Record<string, string>;
  readonly attributes: Record<string, string>;
  readonly listeners: Record<string, Array<(event: unknown) => void>>;
  readonly classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, force?: boolean): void;
    contains(name: string): boolean;
  };
  parentElement: FakeNode | null;
  appendChild(child: FakeNode): FakeNode;
  removeChild(child: FakeNode): FakeNode;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(name: string, fn: (event: unknown) => void): void;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
  /** This node or the nearest ancestor matching `selector`, as the DOM's does. */
  closest(selector: string): FakeNode | null;
  matches(selector: string): boolean;
  readonly firstChild: FakeNode | null;
  /** Every node beneath this one, this one included. */
  descendants(): FakeNode[];
}

/**
 * The selector subset the views actually use, in one place.
 *
 * `.class`, `[data-x]`, `[data-x="v"]` and a bare tag name — that is every form
 * across all nine views. Anything else THROWS rather than quietly matching
 * nothing: a selector this cannot parse would otherwise turn into a passing test
 * that asserts on an element it never found.
 */
function matchesSelector(node: FakeNode, selector: string): boolean {
  const cls = /^\.([\w-]+)$/.exec(selector);
  if (cls) return node.className.split(/\s+/).includes(cls[1]!);

  const attrWithValue = /^\[([\w-]+)="([^"]*)"\]$/.exec(selector);
  if (attrWithValue) return node.attributes[attrWithValue[1]!] === attrWithValue[2];

  const attr = /^\[([\w-]+)\]$/.exec(selector);
  if (attr) return node.attributes[attr[1]!] !== undefined;

  const tag = /^([a-zA-Z][\w-]*)$/.exec(selector);
  if (tag) return node.tagName === tag[1]!.toLowerCase();

  throw new Error(
    `the pair-view harness cannot parse the selector "${selector}". Add it to `
    + 'matchesSelector() rather than letting it match nothing — a selector that '
    + 'silently finds no element is a test that silently asserts nothing.',
  );
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
    selected: false,
    open: false,
    type: '',
    // Replaced below by an accessor pair; declared here so the object literal
    // satisfies FakeNode.
    innerHTML: '',
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    listeners: {},
    parentElement: null,

    // Backed by `className`, so the two never disagree — the light picker and
    // the source picker both set one and read the other.
    classList: {
      add(name) {
        const names = node.className.split(/\s+/).filter(Boolean);
        if (!names.includes(name)) names.push(name);
        node.className = names.join(' ');
      },
      remove(name) {
        node.className = node.className.split(/\s+/).filter(n => n && n !== name).join(' ');
      },
      toggle(name, force) {
        const has = node.classList.contains(name);
        const wanted = force === undefined ? !has : force;
        if (wanted) node.classList.add(name);
        else node.classList.remove(name);
      },
      contains(name) {
        return node.className.split(/\s+/).includes(name);
      },
    },

    appendChild(child) {
      // A fragment appends its CONTENTS and vanishes, which is the whole reason
      // `mapping.html` builds its function rows into one: appending a fragment
      // as if it were an element would nest every row one level too deep, and
      // every selector in a test would then be wrong in the same invisible way.
      if (child.tagName === '#fragment') {
        for (const grandchild of [...child.children]) {
          child.removeChild(grandchild);
          node.appendChild(grandchild);
        }
        return child;
      }
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
    // Searching DESCENDANTS, not this node — the DOM's own semantics. `closest`
    // is the one that includes self, and the two are easy to confuse.
    querySelector(selector) {
      return node.descendants().slice(1).find(c => matchesSelector(c, selector)) ?? null;
    },
    querySelectorAll(selector) {
      return node.descendants().slice(1).filter(c => matchesSelector(c, selector));
    },
    closest(selector) {
      let current: FakeNode | null = node;
      while (current) {
        if (matchesSelector(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    matches(selector) {
      return matchesSelector(node, selector);
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

  /**
   * `innerHTML =` reparses; reading it REFUSES.
   *
   * Two views build their rows as strings and assign them — `pointHtml` in
   * `curve.html` and `entryHtml` in `schedule.html` — and they are the two most
   * logic-heavy screens in the app, so a harness without this covers neither.
   * (They are also the two entries on `webview-safety.test.ts`'s `innerHTML`
   * allowlist, which is why every value inside them goes through `escapeHtml`.)
   *
   * The getter throws instead of serialising the tree back to markup. Nothing in
   * any view reads `innerHTML`, and a getter that returned an approximation
   * would be a quiet way for a test to assert against markup this file invented
   * rather than markup a view produced.
   */
  Object.defineProperty(node, 'innerHTML', {
    enumerable: false,
    get(): string {
      throw new Error(
        'the pair-view harness does not serialise innerHTML back to markup. '
        + 'Assert on the parsed tree — children, textContent, getAttribute — '
        + 'which is what the view itself manipulates.',
      );
    },
    set(html: string) {
      node.children.splice(0, node.children.length);
      node.textContent = '';
      parseInto(String(html), node, { rootIsFirstTag: false, stopAtScript: false });
    },
  });

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
  parseInto(html.slice(html.indexOf('<div class="wrap"')), root, {
    rootIsFirstTag: true,
    stopAtScript: true,
  });
}

/**
 * The settings page's markup, which has no `.wrap` root of its own.
 *
 * It is a whole document rather than a fragment injected into somebody else's,
 * so its tokens sit on `:root` and its body IS the root. The `<body>` tag is
 * consumed as that root, exactly as `parseBody` consumes `.wrap`.
 */
function parseSettingsBody(html: string, root: FakeNode): void {
  parseInto(html.slice(html.indexOf('<body')), root, {
    rootIsFirstTag: true,
    stopAtScript: true,
  });
}

const VOID = new Set(['input', 'br', 'img', 'hr', 'line', 'polyline', 'path', 'circle', 'rect']);

/** The five `escapeHtml()` produces, undone. */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    // Ampersand last, or `&amp;lt;` decodes twice.
    .replace(/&amp;/g, '&');
}

/**
 * Scan markup into an element tree.
 *
 * Shared by the whole-view parse and by `innerHTML =`, which is the point:
 * a row built by `pointHtml` must land in the same shape as a row written into
 * the file, or a test proves something about the harness rather than the view.
 *
 * Text IS captured, unlike the original body-only parser, because the strings
 * these two views build are interpolated INTO the markup rather than assigned
 * through `textContent` afterwards — `<option value="6" selected>06</option>`
 * carries the only copy of "06" there is.
 */
function parseInto(
  html: string,
  root: FakeNode,
  options: { rootIsFirstTag: boolean; stopAtScript: boolean },
): void {
  const stack = [root];
  const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;

  let match: RegExpExecArray | null;
  let first = options.rootIsFirstTag;
  let cursor = 0;
  while ((match = tag.exec(html)) !== null) {
    const [whole, closing, name, attrs, selfClosing] = match;
    if (options.stopAtScript && name!.toLowerCase() === 'script') break;

    // Whatever sat between the last tag and this one belongs to the open
    // element. Markup indentation is not content, so it is trimmed away.
    const between = html.slice(cursor, match.index).trim();
    if (between) stack[stack.length - 1]!.textContent += decodeEntities(between);
    cursor = match.index + whole!.length;

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

  const trailing = html.slice(cursor).trim();
  if (trailing) stack[stack.length - 1]!.textContent += decodeEntities(trailing);
}

function applyAttrs(node: FakeNode, attrs: string): void {
  for (const [, name, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
    node.setAttribute(name!, decodeEntities(value!));
    if (name!.startsWith('data-')) {
      const key = name!.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
      node.dataset[key] = decodeEntities(value!);
    }
    if (name === 'type') node.type = value!;
    // The views read `.value` off a select or an input directly, so an attribute
    // that only reached `attributes` would be invisible to them.
    if (name === 'value') node.value = decodeEntities(value!);
    if (name === 'style') {
      for (const rule of value!.split(';')) {
        const [property, setting] = rule.split(':');
        if (property && setting) {
          node.style[property.trim().replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = setting.trim();
        }
      }
    }
  }

  // Bare attributes — `<option value="6" selected>`, `<button disabled>`. The
  // valued regex above cannot see them, and `selected` is how `options()` and
  // `colourOptions()` say which value a select is showing.
  const bare = attrs.replace(/([\w-]+)="[^"]*"/g, ' ');
  for (const [, name] of bare.matchAll(/(?:^|\s)([\w-]+)(?=\s|$)/g)) {
    const lowered = name!.toLowerCase();
    if (lowered === 'selected') node.selected = true;
    if (lowered === 'checked') node.checked = true;
    if (lowered === 'disabled') node.disabled = true;
    node.attributes[lowered] ??= '';
  }
}

export interface ViewRun {
  /** The view's root element, after its script has run. */
  root: FakeNode;
  /** Every `emit()` the view made, in order. */
  emitted: Array<{ event: string; data: unknown }>;
  /**
   * Every screen the view sent the user to, in order.
   *
   * `showView` is how the credential screen skips itself when a key is already
   * saved, so "did it navigate" and "did it show the form" are the same
   * question asked two ways — and asking only one of them misses the case where
   * it does both.
   */
  shown: string[];
  /** Devices staged through `Homey.createDevice`, and whether `done()` was called. */
  created: unknown[];
  finished: boolean;
  /** Anything the script threw, which is the whole point of this harness. */
  error: unknown;
  byId(id: string): FakeNode | null;
  /** Fire a listener the view registered, as the container would. */
  fire(node: FakeNode, event: string, payload?: Record<string, unknown>): void;
  /**
   * Fire a DELEGATED listener, the way a real click does.
   *
   * `curve.html` and `schedule.html` listen on the list and reach the row with
   * `event.target.closest('[data-act]')`, so a listener fired with the list as
   * its own target finds nothing and the test passes by doing nothing. This
   * fires the listener registered on an ANCESTOR, with `target` set to the node
   * that was actually clicked.
   */
  click(node: FakeNode, event?: string): void;
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
  const shown: string[] = [];
  const created: unknown[] = [];
  let finished = false;

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
    showView: (view: string) => { shown.push(view); },
    done: () => { finished = true; },
    createDevice: async (device: unknown) => {
      created.push(device);
      return device;
    },
  };

  const document = {
    getElementById: byId,
    createElement: makeNode,
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createDocumentFragment: () => makeNode('#fragment'),
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
    shown,
    created,
    get finished() {
      return finished;
    },
    error,
    byId,
    fire(node, event, payload = {}) {
      for (const listener of node.listeners[event] ?? []) {
        listener({ target: node, ...payload });
      }
    },
    click(node, event = 'click') {
      // Walk up to whichever ancestor is actually listening, the way the browser
      // does on the way back down. Only the first one found fires: no view
      // depends on a second handler further up, and firing every ancestor would
      // invent bubbling behaviour the views were never written against.
      for (let current: FakeNode | null = node; current; current = current.parentElement) {
        const listeners = current.listeners[event];
        if (!listeners?.length) continue;
        for (const listener of listeners) listener({ target: node });
        return;
      }
      throw new Error(
        `nothing listens for "${event}" on <${node.tagName}> or any of its ancestors`,
      );
    },
    async settle() {
      for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
    },
  };
}

// ------------------------------------------------------------ settings page

export interface SettingsCall {
  method: string;
  path: string;
  body: unknown;
}

export interface SettingsRun {
  /** The page's `<body>`, after `onHomeyReady` has run and settled. */
  root: FakeNode;
  /** Every app-API call the page made, in order. */
  calls: SettingsCall[];
  error: unknown;
  byId(id: string): FakeNode | null;
  fire(node: FakeNode, event: string, payload?: Record<string, unknown>): void;
  settle(): Promise<void>;
}

export interface SettingsOptions {
  /**
   * What each `<METHOD> <path>` resolves to — `'GET /'`, `'POST /credential'`.
   * An unlisted route rejects, so a page that starts calling something new
   * fails loudly rather than rendering half of itself.
   */
  respond?: Record<string, unknown>;
  translate?: (key: string, tokens?: Record<string, unknown>) => string;
}

/**
 * Run `settings/index.html` the way Homey's settings frame does.
 *
 * Different enough from a pair view to need its own entry point, and the
 * differences are the reason it had no coverage at all: it is a whole document
 * rather than a fragment, it has no boot guard and no `waitForHomey` poller, it
 * boots from a GLOBAL `onHomeyReady(Homey)` that the container calls, and it
 * talks to the app over `Homey.api(method, path, body, callback)` rather than
 * `Homey.emit`.
 *
 * What it buys: the four empty-state sections and the four populated ones — the
 * old test plan's 1.2 and 8.1 — stop being things a person reads off a phone.
 */
export function runSettingsPage(html: string, options: SettingsOptions = {}): SettingsRun {
  const root = makeNode('body');
  parseSettingsBody(html, root);

  const byId = (id: string) => root.descendants().find(node => node.id === id) ?? null;
  const calls: SettingsCall[] = [];

  const homey = {
    __: options.translate ?? ((key: string) => key),
    ready: () => undefined,
    api: (
      method: string,
      path: string,
      body: unknown,
      callback: (error: unknown, result?: unknown) => void,
    ) => {
      calls.push({ method, path, body });
      const responses = options.respond ?? {};
      const route = `${method} ${path}`;
      if (Object.prototype.hasOwnProperty.call(responses, route)) {
        // Asynchronous, like the real one: a synchronous callback would let a
        // page pass that depends on ordering the container does not give it.
        setImmediate(() => callback(null, responses[route]));
      } else {
        setImmediate(() => callback(new Error(`no stub for "${route}"`)));
      }
    },
    alert: () => undefined,
    popup: () => undefined,
  };

  const document = {
    getElementById: byId,
    createElement: makeNode,
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createDocumentFragment: () => makeNode('#fragment'),
    createTextNode: (text: string) => {
      const node = makeNode('#text');
      node.textContent = text;
      return node;
    },
    documentElement: makeNode('html'),
    body: root,
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
  };

  const script = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('settings/index.html has no inline <script>');

  const window: Record<string, unknown> = {};

  let error: unknown = null;
  let boot: ((homey: unknown) => void) | undefined;
  try {
    // `onHomeyReady` is declared as a function statement, so it is returned
    // explicitly: `new Function` gives it its own scope and the container's
    // call is what starts the page.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function(
      'document', 'window', 'navigator',
      'setTimeout', 'clearTimeout', 'console',
      `${script}\nreturn typeof onHomeyReady === 'function' ? onHomeyReady : undefined;`,
    );
    boot = run(
      document, window,
      { clipboard: { writeText: () => Promise.resolve() } },
      () => 0, () => undefined,
      { log: () => undefined, error: () => undefined },
    ) as ((homey: unknown) => void) | undefined;

    if (typeof boot !== 'function') throw new Error('the page defines no onHomeyReady');
    boot(homey);
  } catch (thrown) {
    error = thrown;
  }

  return {
    root,
    calls,
    error,
    byId,
    fire(node, event, payload = {}) {
      for (const listener of node.listeners[event] ?? []) listener({ target: node, ...payload });
    },
    async settle() {
      for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve));
    },
  };
}
