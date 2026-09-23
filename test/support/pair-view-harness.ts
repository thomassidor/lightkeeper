/**
 * Run a pairing view's script the way the pairing container does, with a DOM
 * small enough to fit in this file.
 *
 * This exists because of a bug that shipped: a daylight screen (since folded
 * away) was generated with its own boot preamble (`var root` / `data-booted`)
 * while the SHARED `stabiliseScrollbar()` helper it also carried reads `__root`
 * by name. The view
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
  /**
   * A real DOM's, not a field: reading it concatenates every descendant's text
   * — `createTextNode` children and parsed markup text alike — and writing it
   * replaces ALL children with one text node.
   *
   * It was a plain field, which let two wrong things pass. A view that wrote a
   * label with `appendChild(createTextNode(...))` read back as empty from its
   * parent, and a view that set `textContent` on an element that still held
   * child elements kept them — so a stale row could survive a re-render here
   * and nowhere else.
   */
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  selected: boolean;
  /**
   * How far this element is scrolled. Only the container's scroller is ever
   * given one on a real Homey, and a view sets it to put a newly opened room in
   * front of somebody — so it is here to be asserted rather than to be read.
   */
  scrollTop: number;
  /** `<details>`. The mapping screen opens a collapsed section to show a note. */
  open: boolean;
  /**
   * `hidden`. The daylight card is ONE file on several drivers and hides its own
   * Save footer where the surrounding screen owns it, so whether it is hidden is
   * a rule worth asserting rather than a detail.
   */
  hidden: boolean;
  /**
   * `min` / `max` on a number input. The daylight card bounds its two lux fields
   * by what the driver's sanitiser will actually accept, so a number that would
   * be clamped cannot be typed in the first place.
   */
  min: string;
  max: string;
  type: string;
  /** Set to reparse this node's children. Reading it is refused — see below. */
  innerHTML: string;
  /** ELEMENT children only, as the DOM's `children` is. */
  readonly children: FakeNode[];
  /** Every child, text nodes included — what `firstChild` and `removeChild` walk. */
  readonly childNodes: FakeNode[];
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
  /** The first child NODE, text included — which is what every view's `clear()` loops on. */
  readonly firstChild: FakeNode | null;
  /** Every ELEMENT beneath this one, this one included. Text nodes are not elements. */
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

const TEXT = '#text';

function textNode(text: string): FakeNode {
  const node = makeNode(TEXT);
  node.textContent = text;
  return node;
}

function makeNode(tagName: string): FakeNode {
  const childNodes: FakeNode[] = [];
  // Only a text node holds text of its own; an element's is its descendants'.
  let data = '';
  const node: FakeNode = {
    tagName: tagName.toLowerCase(),
    id: '',
    className: '',
    // Replaced below by an accessor pair, like `innerHTML`.
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    selected: false,
    scrollTop: 0,
    open: false,
    hidden: false,
    min: '',
    max: '',
    type: '',
    // Replaced below by an accessor pair; declared here so the object literal
    // satisfies FakeNode.
    innerHTML: '',
    get children() {
      return childNodes.filter(child => child.tagName !== TEXT);
    },
    childNodes,
    style: {},
    /**
     * A real `dataset` writes THROUGH to the attribute, and several views depend
     * on it: `buttons.html` sets `row.dataset.key` and then finds the row again
     * with `querySelector('[data-key=...]')` when a press arrives. A plain
     * object here stores the value and matches nothing, which passes as a test
     * that quietly asserts on a row it never found.
     */
    dataset: new Proxy({} as Record<string, string>, {
      set(store, property: string, value: string) {
        store[property] = String(value);
        node.attributes[`data-${property.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`] = String(value);
        return true;
      },
    }),
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
        for (const grandchild of [...child.childNodes]) {
          child.removeChild(grandchild);
          node.appendChild(grandchild);
        }
        return child;
      }
      // A node lives in one place, as in the DOM: re-appending moves it.
      child.parentElement?.removeChild(child);
      child.parentElement = node;
      childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const at = childNodes.indexOf(child);
      if (at >= 0) childNodes.splice(at, 1);
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
      return childNodes[0] ?? null;
    },
    descendants() {
      const found: FakeNode[] = [node];
      for (const child of node.children) found.push(...child.descendants());
      return found;
    },
  };

  Object.defineProperty(node, 'textContent', {
    enumerable: true,
    get(): string {
      if (node.tagName === TEXT) return data;
      return childNodes.map(child => child.textContent).join('');
    },
    set(text: unknown) {
      const value = text === null || text === undefined ? '' : String(text);
      if (node.tagName === TEXT) {
        data = value;
        return;
      }
      for (const child of childNodes.splice(0, childNodes.length)) child.parentElement = null;
      if (value) node.appendChild(textNode(value));
    },
  });

  /**
   * `innerHTML =` reparses; reading it REFUSES.
   *
   * No view assigns `innerHTML` any more (`webview-safety.test.ts` enforces it),
   * so the setter is here for the harness's own parse and for a test that wants
   * to build a fragment of markup; it is not a path any screen takes.
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
 * elements by — plus whatever static text the markup carries, as text nodes.
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

/** The five HTML entities markup can carry, undone. */
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
 * Shared by the whole-view parse and by `innerHTML =`, so markup lands in one
 * shape whichever way it arrives.
 *
 * Text is captured as text NODES, in document order beside the elements, so
 * `textContent` reads it back the way a browser would — static markup text such
 * as `<option value="6">06</option>` carries the only copy of "06" there is.
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
    if (between) stack[stack.length - 1]!.appendChild(textNode(decodeEntities(between)));
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
  if (trailing) stack[stack.length - 1]!.appendChild(textNode(decodeEntities(trailing)));
}

function applyAttrs(node: FakeNode, attrs: string): void {
  for (const [, name, value] of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
    node.setAttribute(name!, decodeEntities(value!));
    if (name!.startsWith('data-')) {
      const key = name!.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
      node.dataset[key] = decodeEntities(value!);
    }
    if (name === 'type') node.type = value!;
    // The daylight card reads and rewrites these, so an attribute that only
    // reached `attributes` would be invisible to it.
    if (name === 'min') node.min = value!;
    if (name === 'max') node.max = value!;
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
    if (lowered === 'hidden') node.hidden = true;
    node.attributes[lowered] ??= '';
  }
}

export interface ViewRun {
  /** The view's root element, after its script has run. */
  root: FakeNode;
  /**
   * The pairing container's scrolling element — the root's parent here, and a
   * real ancestor on a Homey, which is why every view finds it by walking up.
   *
   * Exposed so `scrollTop` can be asserted: a picker that opens a room renders
   * that room ABOVE the list it was tapped in, so the scroll is the only thing
   * that puts it in front of anybody.
   */
  scroller: FakeNode;
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
   * A view that listens on a list and reaches the row with
   * `event.target.closest(...)` finds nothing when the listener is fired with
   * the list as its own target, and the test passes by doing nothing. This
   * fires the listener registered on an ANCESTOR, with `target` set to the node
   * that was actually clicked.
   */
  click(node: FakeNode, event?: string): void;
  /**
   * Push an event to the view, as the driver does through `Homey.on`.
   *
   * The buttons screen highlights the row a real press belongs to and the listen
   * screen navigates when it hears one — both arrive this way rather than as a
   * reply to something the view asked for, so there is no `emit` to stand in for
   * them.
   */
  push(event: string, data: unknown): void;
  /** Let the view's promises settle. */
  settle(): Promise<void>;
}

export interface ViewOptions {
  /**
   * What each `emit(event)` resolves to. An absent event rejects, and a stub
   * that IS an `Error` rejects with it — which is how a test reaches the
   * failure path of a screen whose happy path it also drives.
   */
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
  const listeners: Record<string, Array<(data: unknown) => void>> = {};

  const homey = {
    __: options.translate ?? ((key: string) => key),
    // The container's Homey has this; every view calls it once at boot.
    ready: () => undefined,
    emit: (event: string, data: unknown) => {
      emitted.push({ event, data });
      const responses = options.respond ?? {};
      if (!Object.prototype.hasOwnProperty.call(responses, event)) {
        return Promise.reject(new Error(`no stub for "${event}"`));
      }
      const reply = responses[event];
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    /**
     * The container pushes events to a view with `Homey.on`.
     *
     * Two screens listen: the buttons screen highlights the row a real press
     * belongs to, and the listen screen navigates when it hears one. Both call
     * this at boot, so a stub that is missing takes the whole view down before
     * its first `emit` — which is the failure this harness exists to catch and
     * would have reported as "never emitted anything".
     *
     * Handlers are kept so a test can fire one: `push(event, data)` below is how
     * a press is simulated without a Homey.
     */
    on: (event: string, handler: (data: unknown) => void) => {
      (listeners[event] ??= []).push(handler);
    },
    showView: (view: string) => { shown.push(view); },
    done: () => { finished = true; },
    createDevice: async (device: unknown) => {
      created.push(device);
      return device;
    },
  };

  /**
   * The pairing container's scroller, which a view finds by walking up from its
   * own root — so the harness has to give the root a parent that reports itself
   * as scrolling, or the two things views do with it (reserving the scrollbar
   * gutter, scrolling a newly opened room into view) are untestable.
   */
  const scroller = makeNode('div');
  scroller.appendChild(root);

  const document = {
    getElementById: byId,
    createElement: makeNode,
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    createDocumentFragment: () => makeNode('#fragment'),
    createTextNode: textNode,
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
      (node: FakeNode) => ({ overflowY: node === scroller ? 'auto' : 'visible' }),
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
    /** The pairing container's scrolling element, for `scrollTop`. */
    scroller,
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
    /** Simulate the driver pushing an event to the view, as `Homey.on` receives it. */
    push(event: string, data: unknown) {
      for (const listener of listeners[event] ?? []) listener(data);
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
    createTextNode: textNode,
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
