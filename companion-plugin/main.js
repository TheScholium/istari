/*
 * Istari Companion
 *
 * 1. Sidenotes. Footnotes, inline ^[...] or labelled [^x], become margin
 *    notes in Reading view and in Live Preview. In Live Preview the source
 *    returns whenever the cursor enters it, as link and bold syntax do.
 *    The theme places notes in a right-hand margin when the pane is wide
 *    enough (this plugin measures it), and otherwise the reference number
 *    opens the note in place. A note beginning with "? " is a query. The
 *    footnote list at the foot is hidden on screen but kept for PDF export.
 *
 * 2. Callout shorthand. Typing THEOREM (or DEFINITION, LEMMA, PROOF, ...) at
 *    the start of a line, followed by a space, colon or Enter, turns the line
 *    into "> [!theorem] ". One undo restores the plain word.
 *
 * 3. Untitled callouts. Obsidian fills an untitled callout's title with its
 *    type name, which CSS cannot tell apart from a typed title. Callouts whose
 *    title equals their type are marked data-istari-untitled.
 */
const {
  Plugin, Component, MarkdownRenderer, MarkdownRenderChild, MarkdownView,
  editorLivePreviewField, editorInfoField,
} = require("obsidian");
const { ViewPlugin, Decoration, WidgetType, EditorView, keymap } = require("@codemirror/view");
const { RangeSetBuilder, Prec } = require("@codemirror/state");
const { isolateHistory } = require("@codemirror/commands");
const { syntaxTree } = require("@codemirror/language");

const WIDE_PX = 980;

/* ---------- Footnote scanning ---------- */

// Footnote references in a stretch of Markdown, in order, with positions,
// skipping code and math. Definitions ("[^x]: ...") are not references.
function scanFootnotes(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      let j = i;
      while (src[j] === "`") j++;
      const k = src.indexOf(src.slice(i, j), j);
      i = k < 0 ? j : k + (j - i);
      continue;
    }
    if (c === "$") {
      const d = src[i + 1] === "$" ? "$$" : "$";
      const k = src.indexOf(d, i + d.length);
      i = k < 0 ? i + d.length : k + d.length;
      continue;
    }
    if (c === "^" && src[i + 1] === "[") {
      let depth = 0, j = i + 1;
      for (; j < n; j++) {
        if (src[j] === "\\") { j++; continue; }
        if (src[j] === "[") depth++;
        else if (src[j] === "]" && --depth === 0) break;
      }
      if (j < n) { out.push({ from: i, to: j + 1, inline: src.slice(i + 2, j) }); i = j + 1; continue; }
    }
    if (c === "[" && src[i + 1] === "^") {
      const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(i, i + 200));
      if (m) {
        const lineHead = src.slice(src.lastIndexOf("\n", i - 1) + 1, i);
        const lineStart = /^(\s*>)*\s*$/.test(lineHead);
        const isDefinition = lineStart && src[i + m[0].length] === ":";
        if (!isDefinition) out.push({ from: i, to: i + m[0].length, label: m[1] });
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Body of a labelled footnote definition, including indented continuation lines.
function findDefinition(text, label) {
  const q = "(?:[ \\t]*>)*[ \\t]*";
  const re = new RegExp("^" + q + "\\[\\^" + escapeRe(label) + "\\]:[ \\t]*(.*(?:\\n" + q + "(?:[ \\t]{2,}|\\t).*)*)", "m");
  const m = re.exec(text);
  return m ? m[1].replace(/\n(?:[ \t]*>)*[ \t]+/g, "\n") : null;
}

// Number footnotes as Obsidian does: in order of first reference; a label
// used twice keeps its first number.
function numberFootnotes(tokens) {
  const byLabel = new Map();
  let next = 1;
  for (const t of tokens) {
    if (t.label !== undefined) {
      if (!byLabel.has(t.label)) byLabel.set(t.label, next++);
      t.number = byLabel.get(t.label);
    } else t.number = next++;
  }
  return tokens;
}

/* ---------- Building a note (shared by both views) ---------- */

function buildNote(app, md, number, sourcePath, component) {
  const note = document.createElement("span");
  note.className = "istari-sidenote";
  if (/^\?\s/.test(md)) { note.classList.add("is-query"); md = md.replace(/^\?\s+/, ""); }

  const num = note.appendChild(document.createElement("span"));
  num.className = "istari-sidenote-number";
  num.textContent = String(number);
  const body = note.appendChild(document.createElement("span"));
  body.className = "istari-sidenote-body";

  const tmp = document.createElement("div");
  MarkdownRenderer.render(app, md, tmp, sourcePath, component).then(() => {
    const src = tmp.children.length === 1 && tmp.firstElementChild.tagName === "P" ? tmp.firstElementChild : tmp;
    while (src.firstChild) body.appendChild(src.firstChild);
  });
  return note;
}

// Build a note from a footnote list item Obsidian has already rendered.
function buildNoteFromItem(li, number) {
  const note = document.createElement("span");
  note.className = "istari-sidenote";
  const num = note.appendChild(document.createElement("span"));
  num.className = "istari-sidenote-number";
  num.textContent = String(number);
  const body = note.appendChild(document.createElement("span"));
  body.className = "istari-sidenote-body";
  const content = li.cloneNode(true);
  content.querySelectorAll(".footnote-backref").forEach((a) => a.remove());
  const src = content.children.length === 1 && content.firstElementChild.tagName === "P" ? content.firstElementChild : content;
  while (src.firstChild) body.appendChild(src.firstChild);
  const first = body.firstChild;
  if (first && first.nodeType === 3 && /^\?\s/.test(first.textContent)) {
    note.classList.add("is-query");
    first.textContent = first.textContent.replace(/^\?\s+/, "");
  }
  return note;
}

function isWide(el) { return !!el.closest(".istari-sn-wide"); }

/* ---------- Live Preview widget ---------- */

class SidenoteWidget extends WidgetType {
  constructor(plugin, md, number, sourcePath) {
    super();
    this.plugin = plugin;
    this.md = md;
    this.number = number;
    this.sourcePath = sourcePath;
  }

  eq(other) {
    return other.md === this.md && other.number === this.number && other.sourcePath === this.sourcePath;
  }

  toDOM(view) {
    const wrap = document.createElement("span");
    wrap.className = "istari-sn-anchor";

    const sup = wrap.appendChild(document.createElement("sup"));
    sup.className = "footnote-ref istari-sidenote-ref";
    sup.appendChild(document.createElement("a")).textContent = String(this.number);

    const component = new Component();
    component.load();
    wrap.istariComponent = component;
    const note = buildNote(this.plugin.app, this.md, this.number, this.sourcePath, component);
    wrap.appendChild(note);

    // Put the cursor inside the footnote, which reveals its source.
    const edit = () => {
      const pos = view.posAtDOM(wrap);
      view.dispatch({ selection: { anchor: Math.min(pos + 2, view.state.doc.length) } });
      view.focus();
    };

    sup.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (isWide(wrap)) edit();
      else note.classList.toggle("is-open");
    });
    note.addEventListener("mousedown", (e) => {
      const link = e.target.closest("a");
      if (link) {
        e.preventDefault();
        if (link.classList.contains("internal-link")) {
          const target = link.getAttribute("data-href") || link.getAttribute("href");
          this.plugin.app.workspace.openLinkText(target, this.sourcePath, e.metaKey || e.ctrlKey);
        } else if (link.href) {
          window.open(link.href);
        }
        return;
      }
      e.preventDefault();
      edit();
    });
    return wrap;
  }

  destroy(dom) {
    if (dom.istariComponent) dom.istariComponent.unload();
  }

  ignoreEvent() { return true; }
}

function sidenoteEditorExtension(plugin) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view); }

    update(u) {
      const lpChanged = u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false);
      if (u.docChanged || u.selectionSet || u.viewportChanged || lpChanged) this.decorations = this.build(u.view);
    }

    build(view) {
      const builder = new RangeSetBuilder();
      if (!view.state.field(editorLivePreviewField, false)) return builder.finish();
      const info = view.state.field(editorInfoField, false);
      const sourcePath = (info && info.file && info.file.path) || "";
      const text = view.state.doc.toString();
      const tokens = numberFootnotes(scanFootnotes(text));
      const sel = view.state.selection.ranges;

      for (const t of tokens) {
        // While the cursor or selection touches a footnote, show its source.
        if (sel.some((r) => r.from <= t.to && r.to >= t.from)) continue;
        const md = t.inline !== undefined ? t.inline : findDefinition(text, t.label);
        if (md == null) continue;
        builder.add(t.from, t.to, Decoration.replace({
          widget: new SidenoteWidget(plugin, md, t.number, sourcePath),
        }));
      }
      return builder.finish();
    }
  }, { decorations: (v) => v.decorations });
}

/* ---------- Callout shorthand ---------- */

const CALLOUT_WORDS = {
  THEOREM: "theorem", THM: "theorem", DEFINITION: "definition", DEF: "definition",
  LEMMA: "lemma", PROPOSITION: "proposition", COROLLARY: "corollary", PROOF: "proof",
  EXAMPLE: "example", REMARK: "remark", AXIOM: "axiom", CONJECTURE: "conjecture",
  INTUITION: "intuition", EXERCISE: "exercise", WARNING: "warning",
};

// If the line up to the cursor is exactly one of the words, return its type.
function shorthandAt(state, pos) {
  const line = state.doc.lineAt(pos);
  const type = CALLOUT_WORDS[state.doc.sliceString(line.from, pos)];
  if (!type || pos !== line.to) return null;
  const node = syntaxTree(state).resolveInner(line.from, 1);
  if (/codeblock|math|frontmatter|comment/i.test(node.type.name)) return null;
  return { line, type };
}

function calloutShorthand() {
  // The typed character goes in first, as its own history step, so that a
  // single undo turns "> [!theorem] " back into the word as typed.
  const expand = (view, hit, tail) => {
    const insert = "> [!" + hit.type + "] " + tail;
    view.dispatch({
      changes: { from: hit.line.from, to: view.state.doc.lineAt(hit.line.from).to, insert },
      selection: { anchor: hit.line.from + insert.length },
      annotations: isolateHistory.of("full"),
      userEvent: "input.istari-callout",
    });
  };

  const onType = EditorView.inputHandler.of((view, from, to, text) => {
    if (text !== " " && text !== ":") return false;
    if (from !== to || !view.state.selection.main.empty) return false;
    const hit = shorthandAt(view.state, from);
    if (!hit) return false;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + 1 }, userEvent: "input.type" });
    expand(view, hit, "");
    return true;
  });

  const onEnter = Prec.highest(keymap.of([{
    key: "Enter",
    run: (view) => {
      const sel = view.state.selection.main;
      if (!sel.empty) return false;
      const hit = shorthandAt(view.state, sel.head);
      if (!hit) return false;
      expand(view, hit, "\n> ");
      return true;
    },
  }]));

  return [onType, onEnter];
}

/* ---------- Untitled callouts ---------- */

const UNTITLED = "data-istari-untitled";

function markCallout(callout) {
  const type = (callout.getAttribute("data-callout") || "").trim().toLowerCase();
  const inner = callout.querySelector(":scope > .callout-title .callout-title-inner");
  if (!type || !inner) return;
  const title = inner.textContent.trim().toLowerCase();
  const untitled = title === "" || title === type;
  if (callout.hasAttribute(UNTITLED) !== untitled) callout.toggleAttribute(UNTITLED, untitled);
}

function scanCallouts(root) {
  if (!(root instanceof HTMLElement)) return;
  if (root.matches(".callout")) markCallout(root);
  root.querySelectorAll(".callout").forEach(markCallout);
  const host = root.closest(".callout");
  if (host) markCallout(host);
}

/* ---------- Plugin ---------- */

module.exports = class IstariCompanion extends Plugin {
  onload() {
    document.body.classList.add("istari-companion");
    this.measured = new WeakSet();

    this.registerMarkdownPostProcessor((el, ctx) => {
      scanCallouts(el);
      return this.renderSidenotes(el, ctx);
    });
    this.registerEditorExtension(sidenoteEditorExtension(this));
    this.registerEditorExtension(calloutShorthand());

    // Clicks on a reference mark in rendered text (Reading view, and callouts
    // rendered in Live Preview) open or light its note. Handled at the window
    // in the capture phase, ahead of Obsidian's own footnote and editing
    // handlers, which would otherwise scroll away or enter edit mode.
    const refFor = (e) => {
      const sup = e.target instanceof Element ? e.target.closest("sup.istari-sidenote-ref") : null;
      return sup && !sup.closest(".istari-sn-anchor") ? sup : null;
    };
    this.registerDomEvent(window, "mousedown", (e) => {
      if (refFor(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    this.registerDomEvent(window, "click", (e) => {
      const sup = refFor(e);
      if (!sup) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const note = sup.nextElementSibling;
      if (!note || !note.classList.contains("istari-sidenote")) return;
      note.classList.toggle("is-open");
      note.classList.remove("is-flash");
      void note.offsetWidth;
      note.classList.add("is-flash");
    }, true);

    // Live Preview builds callouts as editor widgets, so watch the DOM too.
    this.observer = new MutationObserver((records) => {
      for (const r of records) {
        r.addedNodes.forEach((node) => scanCallouts(node));
        if (r.type === "characterData") scanCallouts(r.target.parentElement);
      }
    });

    // Measure each pane: margin notes only where there is room for them.
    this.resizer = new ResizeObserver((entries) => {
      for (const e of entries) e.target.classList.toggle("istari-sn-wide", e.contentRect.width >= WIDE_PX);
    });

    this.app.workspace.onLayoutReady(() => {
      scanCallouts(document.body);
      this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      this.refreshAllLeaves();
    });

    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshAllLeaves()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshAllLeaves()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.refreshAllLeaves(file)));
  }

  onunload() {
    document.body.classList.remove("istari-companion");
    if (this.observer) this.observer.disconnect();
    if (this.resizer) this.resizer.disconnect();
    document.querySelectorAll(`[${UNTITLED}]`).forEach((c) => c.removeAttribute(UNTITLED));
    document.querySelectorAll(".istari-has-sidenotes, .istari-sn-wide").forEach((v) =>
      v.classList.remove("istari-has-sidenotes", "istari-sn-wide"));
  }

  // Mark each Markdown pane: does its note have footnotes (so the margin is
  // reserved before any section renders), and is the pane wide enough?
  refreshAllLeaves(onlyFile) {
    this.app.workspace.getLeavesOfType("markdown").forEach(async (leaf) => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) return;
      const pane = view.containerEl;
      if (!this.measured.has(pane)) { this.measured.add(pane); this.resizer.observe(pane); }
      if (onlyFile && view.file.path !== onlyFile.path) return;
      const text = await this.app.vault.cachedRead(view.file);
      pane.classList.toggle("istari-has-sidenotes", scanFootnotes(text).length > 0);
    });
  }

  // Rendered Markdown (Reading view, and callouts in Live Preview): insert a
  // note after each footnote reference. Notes are built from the source when
  // its references can be matched one to one; otherwise from the footnote list
  // Obsidian rendered alongside (as it does inside a Live Preview callout).
  renderSidenotes(el, ctx) {
    const refs = Array.from(el.querySelectorAll("sup.footnote-ref")).filter((s) => !s.classList.contains("istari-sidenote-ref"));
    if (!refs.length) return;

    const child = new MarkdownRenderChild(el);
    ctx.addChild(child);

    const numberOf = (sup, k) => {
      const a = sup.querySelector("a");
      const m = ((a && a.getAttribute("href")) || "").match(/#fn-(\d+)/) || sup.textContent.match(/\d+/);
      return m ? m[1] || m[0] : String(k + 1);
    };
    const attach = (sup, note, number) => {
      const a = sup.querySelector("a");
      if (a) a.textContent = number;
      sup.classList.add("istari-sidenote-ref");
      sup.insertAdjacentElement("afterend", note);
    };

    // Path 1: from the source
    const info = ctx.getSectionInfo(el);
    if (info) {
      const lines = info.text.split("\n");
      const tokens = scanFootnotes(lines.slice(info.lineStart, info.lineEnd + 1).join("\n"));
      if (tokens.length === refs.length) {
        const mds = tokens.map((t) => (t.inline !== undefined ? t.inline : findDefinition(info.text, t.label)));
        if (mds.every((md) => md != null)) {
          refs.forEach((sup, k) => {
            const number = numberOf(sup, k);
            attach(sup, buildNote(this.app, mds[k], number, ctx.sourcePath, child), number);
          });
          return;
        }
      }
    }

    // Path 2: from the footnote list rendered in the same block
    const items = Array.from(el.querySelectorAll("section.footnotes li[data-footnote-id], .footnotes li[id^='fn-']"));
    if (!items.length) return;
    let used = 0;
    refs.forEach((sup, k) => {
      const number = numberOf(sup, k);
      const li = items.find((item) => new RegExp("^fn-" + number + "(-|$)").test(item.getAttribute("data-footnote-id") || item.id));
      if (!li) return;
      attach(sup, buildNoteFromItem(li, number), number);
      used++;
    });
    if (used === items.length) el.querySelectorAll("section.footnotes").forEach((f) => f.classList.add("istari-converted"));
  }
};
