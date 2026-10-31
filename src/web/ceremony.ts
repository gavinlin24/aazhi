import { STAMP_FONT_PATH } from "./fonts";

// The Ceremony runs on both the bill page and the profile pages, which share no
// script. This is pasted into each one, so the bill page's rules apply: plain
// browser JavaScript, no template literals, never a closing script tag.
//
// options.held says the page is busy with something the Ceremony mustn't cut
// across. The page calls pump() when that clears. options.seen(key) records it,
// and options.seeHref is left out on the Stamps page, which is where it leads.
export const CEREMONY_SCRIPT = String.raw`
  function stampCeremony(options) {
    const GAP_MS = 180;
    const SHEET_MS = 820;
    const shown = new Set();
    let waiting = [];
    let open = false;
    let timer = null;
    let fontAsked = false;

    // A bill page draws fine with nothing fetched, and it stays that way: this
    // only runs once there's a stamp to show. Ahead of the press, so the character
    // lands with it. If it fails the press falls back to the brush fonts.
    function loadFont() {
      if (fontAsked) return;
      fontAsked = true;
      fetch("${STAMP_FONT_PATH}")
        .then((response) => response.arrayBuffer())
        .then((bytes) => {
          const face = new FontFace("AAzhi Stamps", bytes);
          document.fonts.add(face);
          return face.load();
        })
        .catch(() => null);
    }

    function make(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text) node.textContent = text;
      return node;
    }

    function glyph(tag, className, text) {
      const node = make(tag, className, text);
      node.lang = "zh";
      return node;
    }

    function play(stamp) {
      open = true;
      shown.add(stamp.key);
      let up = false;
      const dialog = make("dialog", "ceremony");
      dialog.setAttribute("aria-label", "New stamp");
      const stage = make("div", "ceremony-stage");
      stage.append(glyph("span", "stamp-face is-on is-press", stamp.glyph));
      const sheet = make("div", "ceremony-sheet");
      const title = make("h2");
      title.append(glyph("span", "ceremony-glyph", stamp.glyph), " " + stamp.name);
      const keep = make("button", "ceremony-keep", waiting.length > 0 ? "Next" : "Keep it");
      keep.type = "button";
      keep.addEventListener("click", () => dialog.close());
      sheet.append(make("p", "ceremony-kicker", "New stamp"), title, make("p", "ceremony-line", stamp.line), keep);
      if (options.seeHref) {
        const see = make("a", "ceremony-see", "See your stamps");
        see.href = options.seeHref;
        sheet.append(see);
      }
      dialog.append(stage, sheet);
      // Escape can't skip it before the sheet has said what it was and marked it seen.
      dialog.addEventListener("cancel", (event) => {
        if (!up) event.preventDefault();
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        open = false;
        pump();
      });
      document.body.append(dialog);
      dialog.showModal();
      setTimeout(() => {
        up = true;
        dialog.classList.add("is-up");
        keep.focus({ focusVisible: false });
        options.seen(stamp.key);
      }, SHEET_MS);
    }

    function pump() {
      if (open || timer !== null || waiting.length === 0 || options.held()) return;
      timer = setTimeout(() => {
        timer = null;
        if (open || waiting.length === 0 || options.held()) return;
        play(waiting.shift());
      }, GAP_MS);
    }

    function update(unseen) {
      const queued = new Set(waiting.map((stamp) => stamp.key));
      const fresh = (unseen || []).filter((stamp) => !shown.has(stamp.key) && !queued.has(stamp.key));
      if (fresh.length > 0) loadFont();
      waiting = waiting.concat(fresh);
      pump();
    }

    return { update, pump };
  }
`;

export const CEREMONY_STYLES = `
.stamp-face { display: grid; place-items: center; aspect-ratio: 1; border-radius: 5px; font: 400 21px/1.05 "AAzhi Stamps", var(--brush); writing-mode: vertical-rl; letter-spacing: -1px; }
.stamp-face.is-on { background: var(--seal); color: var(--seal-ink); box-shadow: inset 0 0 0 2px var(--seal), inset 0 0 0 3.5px rgba(251, 243, 234, 0.7); transform: rotate(-3deg); }
.stamp-face.is-off { border: 1.5px dashed var(--ring); color: var(--ring); }
.ceremony { position: fixed; inset: 0; display: none; flex-direction: column; width: 100%; max-width: none; height: 100%; max-height: none; margin: 0; padding: 0; border: 0; overflow: hidden; background: color-mix(in srgb, #000 42%, var(--paper)); color: var(--ink); animation: ceremony-dim 180ms ease both; }
.ceremony[open] { display: flex; }
.ceremony::backdrop { background: transparent; }
.ceremony-stage { display: grid; flex: 1; place-items: center; min-height: 0; }
.ceremony .is-press { width: 112px; font-size: 46px; -webkit-mask: var(--speckle); mask: var(--speckle); animation: stamp-press 620ms both; }
.ceremony-sheet { width: 100%; max-width: 480px; margin: 0 auto; padding: 20px 20px calc(18px + env(safe-area-inset-bottom)); border-radius: 18px 18px 0 0; background: var(--card); text-align: center; transform: translateY(100%); visibility: hidden; transition: transform 260ms cubic-bezier(.2, .8, .3, 1), visibility 0s 260ms; }
.ceremony.is-up .ceremony-sheet { transform: none; visibility: visible; transition-delay: 0s; }
.ceremony-kicker { margin: 0; color: var(--muted); font-size: 15px; }
.ceremony-sheet h2 { margin: 2px 0; font-size: 23px; font-weight: 600; }
.ceremony-glyph { font-family: "AAzhi Stamps", var(--brush); font-weight: 400; color: var(--seal); }
.ceremony-line { margin: 0 0 14px; font-size: 16px; }
.ceremony-keep { display: block; width: 100%; min-height: 46px; border: 0; border-radius: 10px; background: var(--ink); color: var(--card); font: inherit; font-size: 16px; font-weight: 600; cursor: pointer; }
.ceremony-see { display: grid; place-items: center; min-height: 44px; margin-top: 2px; color: var(--muted); font-size: 15px; }
@keyframes ceremony-dim {
  from { opacity: 0; }
}
@keyframes stamp-press {
  0% { transform: scale(2.6) rotate(-24deg); opacity: 0; animation-timing-function: cubic-bezier(.55, 0, 1, .45); }
  40% { transform: scale(.93) rotate(-5deg); opacity: 1; animation-timing-function: ease-out; }
  70% { transform: scale(1.03) rotate(-5deg); }
  100% { transform: scale(1) rotate(-5deg); opacity: 1; }
}
@keyframes stamp-fade {
  from { opacity: 0; transform: rotate(-5deg); }
  to { opacity: 1; transform: rotate(-5deg); }
}
@media (prefers-reduced-motion: reduce) {
  .ceremony .is-press { animation-name: stamp-fade; }
  .ceremony-sheet { transition: none; }
}
`;
