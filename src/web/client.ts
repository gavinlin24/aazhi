// Shipped inline as plain browser JavaScript with no build step, so it is a
// string here rather than a module the Worker imports and runs. String.raw
// keeps its regex backslashes intact, which means the script itself may use
// no template literals. It must never contain a closing script tag, since it
// is pasted between script tags.
//
// The markup it draws mirrors page.ts, which draws the same state on first
// load; a change to either needs the same change in the other.
export const CLIENT_SCRIPT = String.raw`
(() => {
  "use strict";
  const root = document.getElementById("bill");
  const stateBlock = document.getElementById("bill-state");
  if (!root || !stateBlock) return;

  let state;
  try {
    state = JSON.parse(stateBlock.textContent || "");
  } catch (error) {
    return;
  }

  // The server knows this visitor only by the signed token in the link, so
  // every call to it carries the same token.
  const token = new URLSearchParams(location.search).get("t") || "";
  const base = "/b/" + encodeURIComponent(state.billId);
  const POLL_MS = 5000;
  const NOTE_MS = 3500;
  const ARM_MS = 4000;
  const MAX_LABEL = 120;
  const MAX_ADDON_LABEL = 80;
  const MAX_ADDONS = 20;
  const MAX_GUEST_NAME = 40;
  const SVG = "http://www.w3.org/2000/svg";
  const STATUS_WORD = { reading: "Reading", draft: "Draft", confirmed: "Confirmed", superseded: "Replaced", deleted: "Deleted" };
  const layout = root.dataset.layout;

  // Claims tapped but not yet answered. They are drawn over whatever state the
  // server last sent, so a poll or another write landing first never flips a
  // tick back under the finger that just tapped it.
  const pending = [];
  let queue = Promise.resolve();
  let writes = 0;
  let polling = false;
  let stopped = false;
  // Who a tap on a line claims for: the viewer (null), or a guest they
  // brought. The footer shows it and switches it.
  let claimFor = null;
  // The one open inline editor: a totals field, the receipt total, or the
  // add-a-line form.
  let editing = null;
  let tipMode = "dollars";
  let sheet = null;
  let addingGuest = false;
  // Forgive and paid toggles whose answer has not come back, held off a
  // second tap.
  const busy = new Set();
  const armed = new Set();
  let noteTimer = null;

  // Same rules as formatCents on the server, in integers only.
  function money(cents) {
    const abs = Math.abs(cents);
    const rest = abs % 100;
    const dollars = String((abs - rest) / 100).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (cents < 0 ? "-" : "") + "$" + dollars + "." + String(rest).padStart(2, "0");
  }

  function plain(cents) {
    return money(cents).replace(/[$,]/g, "");
  }

  // Same as formatAddons on the server.
  function addonsText(addons) {
    return addons.map((a) => a.cents === 0 ? a.label : a.label + " " + (a.cents > 0 ? "+" : "") + money(a.cents)).join(", ");
  }

  // "12", "12.5", "$1,012.50" and ".5" in; the server's strict "12.50" shape
  // out, or null. Hundredths either way, so it also reads a tip percentage.
  function decimal(text) {
    let value = text.trim().replace(/^\$/, "").replace(/,/g, "").trim();
    if (/^\.\d{1,2}$/.test(value)) value = "0" + value;
    if (/^\d+\.$/.test(value)) value = value.slice(0, -1);
    return /^\d+(\.\d{1,2})?$/.test(value) ? value : null;
  }

  function hundredths(value) {
    const [whole, fraction = ""] = value.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  }

  // A price the receipt read as money off (a comp, or "No cheese -0.50"
  // under a dish) keeps its sign while the payer retypes the amount, since a
  // phone's number pad has no minus key. Anything the payer adds is a charge.
  function amountOf(input) {
    const value = decimal(input.value);
    return value !== null && input.dataset.off !== undefined && hundredths(value) !== 0 ? "-" + value : value;
  }

  // Left empty, an add-on is unpriced.
  function addonPrice(input) {
    return input.value.trim() === "" ? "0.00" : amountOf(input);
  }

  function moneyInput(input, cents) {
    if (cents < 0) input.dataset.off = "";
    return el("div", { class: "money-input" }, [el("span", { "aria-hidden": "true" }, cents < 0 ? "-$" : "$"), input]);
  }

  function signedHundredths(value) {
    return value[0] === "-" ? -hundredths(value.slice(1)) : hundredths(value);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const name in attrs || {}) {
      const value = attrs[name];
      if (value === false || value === null || value === undefined) continue;
      if (name === "class") node.className = value;
      else node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of [].concat(children === undefined ? [] : children)) {
      if (child !== null && child !== false && child !== undefined && child !== "") node.append(child);
    }
    return node;
  }

  function icon(name, extra) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "ic" + (extra ? " " + extra : ""));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const use = document.createElementNS(SVG, "use");
    use.setAttribute("href", "#i-" + name);
    svg.append(use);
    return svg;
  }

  function sr(text) {
    return el("span", { class: "sr" }, text);
  }

  // Mirrors hueOf in page.ts: by id, so a renamed guest keeps their colour.
  function hueOf(id) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.codePointAt(0)) % 1000003;
    return h % 8;
  }

  function initialOf(name) {
    return (Array.from(name.trim())[0] || "?").toUpperCase();
  }

  // Mirrors itemPieces in the split engine, so a piece on the page is the
  // cents the split used.
  function piecesOf(item) {
    const ids = Array.from(new Set(item.claimedBy)).sort();
    const pieces = new Map();
    if (ids.length === 0) return pieces;
    const base = Math.floor(item.cents / ids.length);
    const leftover = item.cents - base * ids.length;
    ids.forEach((id, i) => pieces.set(id, base + (i < leftover ? 1 : 0)));
    return pieces;
  }

  function model(s) {
    return {
      s,
      people: new Map(s.participants.map((p) => [p.id, p])),
      shares: new Map(s.result.shares.map((x) => [x.participant, x])),
      onBill: s.participants.some((p) => p.id === s.viewer),
    };
  }

  function nameOf(v, id) {
    const p = v.people.get(id);
    return p ? p.displayName : id;
  }

  function guestsOf(v, id) {
    return v.s.participants.filter((p) => p.kind === "guest" && p.addedBy === id);
  }

  function membersFirst(v) {
    const members = v.s.participants.filter((p) => p.kind === "member");
    return members.filter((p) => p.id === v.s.viewer).concat(members.filter((p) => p.id !== v.s.viewer));
  }

  function owedOf(v, id) {
    const o = v.s.owing[id];
    return o ? o.owedCents : 0;
  }

  function leftOf(v, id) {
    const o = v.s.owing[id];
    return o ? Math.max(0, o.owedCents - o.paidCents) : 0;
  }

  function paidUp(v, id) {
    const o = v.s.owing[id];
    return v.s.status === "confirmed" && id !== v.s.payerId && Boolean(o) && o.owedCents > 0 && o.paidCents >= o.owedCents;
  }

  // Mirrors debtorOf on the server: a guest's share is asked of whoever added
  // them, unless that is the payer, whom the guest owes directly.
  function debtorOf(p, payerId) {
    return p.kind === "guest" && p.addedBy && p.addedBy !== payerId ? p.addedBy : p.id;
  }

  // Mirrors guestPaid on the server: a member who paid in full paid their
  // guests' shares with it. Paying the adder settles nothing with the payer,
  // so only the adder sees that one as paid.
  function guestPaid(v, p) {
    if (p.paidToPayer === true || (p.paidToHost === true && p.addedBy === v.s.viewer)) return true;
    const debtor = debtorOf(p, v.s.payerId);
    const share = v.shares.get(p.id);
    return debtor !== p.id && paidUp(v, debtor) && !(share && share.pardoned);
  }

  // Each of the two may set only their own mark: the payer's is money that
  // reached them, the adder's is between the adder and the guest.
  function ownMark(v, g) {
    return v.s.viewerIsPayer ? g.paidToPayer === true : g.paidToHost === true;
  }

  function sharesOf(v, ids) {
    return ids.map((id) => v.shares.get(id)).filter(Boolean);
  }

  function forgivenWhole(v, id) {
    const shares = sharesOf(v, [id].concat(guestsOf(v, id).map((g) => g.id)));
    return shares.length > 0 && shares.every((x) => x.pardoned);
  }

  // Who the viewer may tap onto a line: the payer anyone, a member
  // themselves and the guests they brought.
  function canClaimFor(v, id) {
    if (editable(v.s) === "all") return v.people.has(id);
    if (editable(v.s) !== "self") return false;
    const p = v.people.get(id);
    return id === v.s.viewer || Boolean(p && p.kind === "guest" && p.addedBy === v.s.viewer);
  }

  function canManageGuest(v, p) {
    return p.kind === "guest" && (v.s.viewerIsPayer || p.addedBy === v.s.viewer);
  }

  function av(v, id, extra) {
    const p = v.people.get(id);
    const classes = ["av hue-" + hueOf(id), id === v.s.viewer ? "is-viewer" : "", p && p.kind === "guest" ? "is-guest" : "", extra || ""];
    return el("span", { class: classes.filter(Boolean).join(" "), "aria-hidden": "true" }, initialOf(nameOf(v, id)));
  }

  function stack(v, ids, max) {
    if (ids.length === 0) return null;
    const shown = ids.length > max ? ids.slice(0, max - 1) : ids;
    const rest = ids.length - shown.length;
    return el("span", { class: "stack", role: "img", "aria-label": ids.map((id) => nameOf(v, id)).join(", ") },
      shown.map((id) => av(v, id)).concat(rest > 0 ? [el("span", { class: "av more", "aria-hidden": "true" }, "+" + rest)] : []));
  }

  function view() {
    if (pending.length === 0) return state;
    const items = state.items.map((item) => Object.assign({}, item, { claimedBy: item.claimedBy.slice() }));
    for (const op of pending) {
      const item = items.find((i) => i.id === op.itemId);
      if (!item) continue;
      const at = item.claimedBy.indexOf(op.participantId);
      if (op.claimed && at < 0) item.claimedBy.push(op.participantId);
      if (!op.claimed && at >= 0) item.claimedBy.splice(at, 1);
    }
    return Object.assign({}, state, { items });
  }

  function editable(s) {
    return stopped ? "none" : s.editable;
  }

  function showNote(text, warn) {
    const note = root.querySelector("[data-live-note]");
    if (!note) return;
    note.textContent = text;
    note.classList.toggle("is-warn", Boolean(warn));
    note.hidden = false;
    clearTimeout(noteTimer);
    // A warning stays until something replaces it; good news gets out of
    // the way.
    if (!warn) noteTimer = setTimeout(() => { note.hidden = true; }, NOTE_MS);
  }

  // What identifies a control across a redraw: its tag and its data-*
  // attributes. Focus moves to the twin in the fresh node, so a poll never
  // drops the keyboard out of what someone is doing.
  function signature(node) {
    if (!(node instanceof Element)) return null;
    const parts = [node.tagName];
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith("data-") || attr.name === "name") parts.push(attr.name + "=" + attr.value);
    }
    return parts.join("|");
  }

  function swap(old, fresh) {
    const focused = old.contains(document.activeElement) ? signature(document.activeElement) : null;
    old.replaceWith(fresh);
    if (!focused) return;
    const twin = [fresh].concat(Array.from(fresh.querySelectorAll("*"))).find((n) => signature(n) === focused);
    if (twin && typeof twin.focus === "function") twin.focus();
  }

  // Draws a list of keyed children, rebuilding only the ones whose key
  // changed and moving the rest into order. A poll that brings nothing new
  // touches nothing. The server's markup carries no keys, so the first draw
  // replaces it once.
  function patch(parent, entries) {
    const old = new Map();
    for (const child of Array.from(parent.children)) {
      if (child._id !== undefined) old.set(child._id, child);
      else child.remove();
    }
    let previous = null;
    for (const entry of entries) {
      let node = old.get(entry.id);
      if (node) old.delete(entry.id);
      if (!node || node._key !== entry.key) {
        const fresh = entry.build();
        fresh._id = entry.id;
        fresh._key = entry.key;
        if (node) swap(node, fresh);
        node = fresh;
      }
      const slot = previous ? previous.nextElementSibling : parent.firstElementChild;
      if (slot !== node) parent.insertBefore(node, slot);
      previous = node;
    }
    for (const gone of old.values()) gone.remove();
  }

  function keyedInto(parent, key, build) {
    if (parent._key === key) return;
    parent._key = key;
    const focused = parent.contains(document.activeElement) ? signature(document.activeElement) : null;
    parent.replaceChildren.apply(parent, [].concat(build()).filter(Boolean));
    if (!focused) return;
    const twin = Array.from(parent.querySelectorAll("*")).find((n) => signature(n) === focused);
    if (twin && typeof twin.focus === "function") twin.focus();
  }

  // ---- header -------------------------------------------------------------

  function renderHeader(v) {
    const label = root.querySelector("[data-status-label]");
    if (label) {
      keyedInto(label, v.s.status, () => [
        v.s.status === "confirmed"
          ? el("span", { class: "seal", "aria-hidden": "true" }, "定")
          : v.s.status === "draft"
            ? el("span", { class: "seal is-draft", "aria-hidden": "true" }, "稿")
            : el("span", { class: "seal-slot", "aria-hidden": "true" }),
        el("span", { class: "word" }, STATUS_WORD[v.s.status] || v.s.status),
        el("span", { class: "live", "aria-hidden": "true" }),
      ]);
    }
    const slot = root.querySelector("[data-payer-slot]");
    if (!slot) return;
    const canHand = editable(v.s) === "all" && !v.s.hasPayments;
    keyedInto(slot, JSON.stringify([nameOf(v, v.s.payerId), canHand]), () => {
      const inner = [icon("coin"), sr("Paid by "), el("span", { class: "name" }, nameOf(v, v.s.payerId))];
      return canHand
        ? el("button", { type: "button", class: "payer-chip", "data-open-payer": true, "aria-haspopup": "dialog" }, inner.concat(icon("brush", "brush")))
        : el("span", { class: "payer-chip" }, inner);
    });
  }

  // ---- the receipt --------------------------------------------------------

  function rowLabel(v, item, actor) {
    const others = item.claimedBy.filter((id) => id !== actor).map((id) => nameOf(v, id));
    return item.label + (item.addons ? " (" + addonsText(item.addons) + ")" : "") + ", " + money(item.cents) + (others.length > 0 ? ", with " + others.join(", ") : "") +
      (actor !== v.s.viewer ? ", for " + nameOf(v, actor) : "");
  }

  function pieceNode(item, actor) {
    const n = item.claimedBy.length;
    const mine = piecesOf(item).get(actor);
    if (mine === undefined || n < 2) return el("span", { class: "piece" });
    return el("span", { class: "piece" }, ["÷" + n, el("span", { class: "money" }, money(mine))]);
  }

  // Your own tick is a check; claiming for someone else, it is their face.
  function tickNode(v, actor) {
    if (actor === v.s.viewer) return el("span", { class: "tick", "aria-hidden": "true" }, icon("check"));
    return el("span", { class: "tick is-other hue-" + hueOf(actor), "aria-hidden": "true" },
      el("span", { class: "ini" }, initialOf(nameOf(v, actor))));
  }

  // Same as addonLines on the server.
  function addonLines(addons) {
    return addons.map((a) => el("span", { class: "addon-line" }, [
      el("span", { class: "addon-name" }, a.label),
      a.cents === 0 ? null : el("span", { class: "addon-price" }, (a.cents > 0 ? "+" : "") + money(a.cents)),
    ]));
  }

  function rowNode(v, item, actor, mode, target) {
    const mine = item.claimedBy.includes(actor);
    const others = item.claimedBy.filter((id) => id !== actor);
    const inner = () => [
      el("span", { class: "item-label" }, item.label),
      el("span", { class: "item-price" }, [mode === "all" ? icon("brush", "brush") : null, money(item.cents)]),
      item.addons ? el("span", { class: "item-addons" }, addonLines(item.addons)) : null,
      el("span", { class: "who" }, stack(v, others, 5)),
      pieceNode(item, actor),
    ];
    const classes = ["item", mine ? "is-mine" : "", item.claimedBy.length === 0 ? "is-unclaimed" : "", others.length === 0 ? "is-bare" : "", item.addons ? "has-addons" : "", target ? "is-target" : ""];
    const claim = { "data-claim": true, "data-item": item.id, "data-participant": actor, "aria-pressed": String(mine) };
    if (mode === "all") {
      classes.push("has-picker");
      return el("li", { class: classes.filter(Boolean).join(" "), "data-item": item.id }, [
        el("button", Object.assign({ type: "button", class: "tick-btn", "aria-label": item.label + ", " + nameOf(v, actor) }, claim), tickNode(v, actor)),
        el("button", { type: "button", class: "row", "data-open-line": item.id, "aria-haspopup": "dialog", "aria-label": rowLabel(v, item, actor) }, inner()),
      ]);
    }
    if (mode === "self") {
      return el("li", { class: classes.filter(Boolean).join(" "), "data-item": item.id },
        el("button", Object.assign({ type: "button", class: "row", "aria-label": rowLabel(v, item, actor) }, claim), [tickNode(v, actor)].concat(inner())));
    }
    classes.push("is-locked");
    return el("li", { class: classes.filter(Boolean).join(" "), "data-item": item.id }, el("div", { class: "row" }, [tickNode(v, actor)].concat(inner())));
  }

  function renderItems(v) {
    const mode = editable(v.s);
    const actor = claimFor || v.s.viewer;
    for (const section of root.querySelectorAll("[data-items]")) {
      section.classList.toggle("is-editable", mode === "all");
      let list = section.querySelector(":scope > ul.items");
      const empty = section.querySelector(":scope > [data-empty-lines]");
      if (empty) empty.hidden = v.s.items.length > 0;
      if (v.s.items.length === 0) {
        if (list) list.remove();
      } else {
        if (!list) {
          list = el("ul", { class: "items" });
          section.prepend(list);
        }
        const roster = v.s.participants.map((p) => [p.id, p.displayName]);
        const open = sheet && sheet.kind === "line" ? sheet.id : null;
        patch(list, v.s.items.map((item) => ({
          id: item.id,
          key: JSON.stringify([item.label, item.addons, item.cents, item.claimedBy.slice().sort(), roster, actor, mode, item.id === open]),
          build: () => rowNode(v, item, actor, mode, item.id === open),
        })));
      }
      const add = section.querySelector(":scope > [data-add-line]");
      if (add) {
        add.hidden = mode !== "all";
        if (add.hidden && editing && editing.kind === "line") editing = null;
        const open = Boolean(editing && editing.kind === "line");
        if (Boolean(add._open) !== open) {
          add._open = open;
          add.replaceChildren(open ? lineForm(null) : el("button", { type: "button", class: "add-row", "data-add-open": true, "aria-label": "Add a line" }, icon("plus")));
          if (open) add.querySelector("input").focus();
        }
      }
      renderTotals(v, section.querySelector(":scope > [data-totals]"), mode);
    }
  }

  // "Tax (8.2%)": the share of the subtotal, to one decimal, read as part of
  // the label.
  function withPercent(label, part, subtotal) {
    return subtotal > 0 ? label + " (" + ((part * 100) / subtotal).toFixed(1) + "%)" : label;
  }

  function amount(mode, field, key, cents, label) {
    const shown = el("span", { "data-total": key }, cents === null ? "—" : money(cents));
    if (mode !== "all") return shown;
    return el("button", { type: "button", class: "amt", "data-edit-field": field, "aria-label": label + ", " + (cents === null ? "not entered" : money(cents)) }, [icon("brush", "brush"), shown]);
  }

  const FIELD_LABEL = { discount: "Discount", tax: "Tax", tip: "Tip", printedTotal: "Receipt total" };

  function fieldForm(s, field) {
    const id = "edit-" + field;
    const cents = { discount: s.discountCents, tax: s.taxCents, tip: s.tipCents, printedTotal: s.printedTotalCents }[field];
    const percent = field === "tip" && tipMode === "percent";
    const input = el("input", {
      id,
      name: "value",
      inputmode: "decimal",
      autocomplete: "off",
      enterkeyhint: "done",
      placeholder: percent ? "20" : field === "printedTotal" || field === "discount" ? "0.00" : null,
    });
    input.value = percent || cents === null || (field === "discount" && cents === 0) ? "" : plain(cents);
    const parts = [
      el("label", { for: id }, FIELD_LABEL[field]),
      el("div", { class: "money-input" + (percent ? " is-percent" : "") }, [el("span", { "data-unit": true, "aria-hidden": "true" }, percent ? "%" : field === "discount" ? "−$" : "$"), input]),
    ];
    if (field === "tip") {
      parts.push(el("div", { class: "seg", role: "group", "aria-label": "Enter the tip as" }, [
        el("button", { type: "button", "data-tip-mode": "dollars", "aria-pressed": String(!percent) }, "$"),
        el("button", { type: "button", "data-tip-mode": "percent", "aria-pressed": String(percent) }, "%"),
      ]));
    }
    parts.push(
      el("button", { type: "button", class: "icon-btn", "data-cancel": true, "aria-label": "Cancel" }, icon("close")),
      el("button", { type: "submit", class: "icon-btn go", "aria-label": "Save" }, icon("check")),
      el("p", { class: "field-msg", role: "status" }),
    );
    return el("form", { class: "edit-form", "data-field": field, novalidate: true }, parts);
  }

  function renderTotals(v, dl, mode) {
    if (!dl) return;
    const s = v.s;
    const r = s.result;
    const entries = [];
    const row = (id, key, cls, build) => entries.push({ id, key: JSON.stringify(key), build: () => el("div", { class: "trow" + (cls ? " " + cls : "") }, build()) });
    const field = (name, key, cents, label, shown) => {
      if (editing && editing.kind === "field" && editing.field === name) {
        entries.push({ id: name, key: "editing:" + tipMode, build: () => el("div", { class: "trow is-editing", "data-field-row": name }, fieldForm(s, name)) });
        return;
      }
      entries.push({
        id: name,
        key: JSON.stringify([cents, mode, shown]),
        build: () => el("div", { class: "trow", "data-field-row": name }, [el("dt", null, shown), el("dd", null, amount(mode, name, key, cents, label))]),
      });
    };
    row("subtotal", [r.billSubtotalCents], "", () => [el("dt", null, "Subtotal"), el("dd", { "data-total": "subtotal" }, money(r.billSubtotalCents))]);
    // The payer sees it at $0.00 too, since that row is where they add one.
    if (s.discountCents !== 0 || mode === "all") field("discount", "discount", -s.discountCents, "Discount", withPercent("Discount", s.discountCents, r.billSubtotalCents));
    // Tax is charged on what's left after the discount, so that is the base
    // a diner would check their local rate against.
    field("tax", "tax", s.taxCents, "Tax", withPercent("Tax", s.taxCents, r.billSubtotalCents - s.discountCents));
    field("tip", "tip", s.tipCents, "Tip", withPercent("Tip", s.tipCents, r.billSubtotalCents));
    row("total", [r.distributableCents], "grand", () => [el("dt", null, "Total"), el("dd", { "data-total": "total" }, money(r.distributableCents))]);
    if (r.unclaimedCents !== 0) {
      row("unclaimed", [r.unclaimedCents], "short", () => [
        el("dt", null, [icon("cloud", "cloud"), "Unclaimed"]),
        el("dd", { "data-total": "unclaimed" }, money(r.unclaimedCents)),
      ]);
    }
    patch(dl, entries);
    tipPreview(s);
  }

  function tipPreview(s) {
    const form = root.querySelector('form[data-field="tip"]');
    if (!form) return;
    const msg = form.querySelector(".field-msg");
    if (msg._error) return;
    msg.classList.add("is-hint");
    if (tipMode !== "percent") {
      msg.textContent = "";
      return;
    }
    const subtotal = Math.max(0, s.result.billSubtotalCents);
    const typed = decimal(form.elements.value.value.replace(/%\s*$/, ""));
    const points = typed === null ? null : hundredths(typed);
    if (points === null || points > 10000) {
      msg.textContent = "";
      return;
    }
    const n = subtotal * points + 5000;
    msg.textContent = "= " + money((n - (n % 10000)) / 10000);
  }

  // ---- people -------------------------------------------------------------

  function tileLabel(v, p) {
    const guests = guestsOf(v, p.id).map((g) => g.displayName);
    return [p.displayName + (p.id === v.s.viewer ? " (you)" : ""), money(owedOf(v, p.id))]
      .concat(guests.length > 0 ? ["with " + guests.join(", ")] : [])
      .concat(p.id === v.s.payerId ? ["paid the bill"] : [])
      .concat(forgivenWhole(v, p.id) ? ["forgiven"] : [])
      .concat(paidUp(v, p.id) ? ["paid"] : [])
      .join(", ");
  }

  function tileNode(v, p) {
    const guests = guestsOf(v, p.id);
    const forgiven = forgivenWhole(v, p.id);
    const shown = forgiven
      ? sharesOf(v, [p.id].concat(guests.map((g) => g.id))).reduce((n, x) => n + x.owedCents, 0)
      : owedOf(v, p.id);
    return el("li", null, el("button", {
      type: "button",
      class: "tile" + (p.id === v.s.viewer ? " is-viewer" : ""),
      "data-person": p.id,
      "aria-haspopup": "dialog",
      "aria-label": tileLabel(v, p),
    }, [
      el("span", { class: "avw" }, [
        av(v, p.id),
        p.id === v.s.payerId ? el("span", { class: "badge coin", "aria-hidden": "true" }, icon("coin")) : null,
        forgiven ? el("span", { class: "badge gift", "aria-hidden": "true" }, icon("gift")) : null,
        guests.length > 0 ? el("span", { class: "minis", "aria-hidden": "true" }, guests.slice(0, 2).map((g) => av(v, g.id))) : null,
        paidUp(v, p.id) ? el("span", { class: "stamp", "aria-hidden": "true" }, "付讫") : null,
      ]),
      el("span", { class: "tile-name" }, p.displayName),
      el("span", { class: "tile-amt money" + (forgiven ? " is-forgiven" : ""), "data-owed": p.id }, money(shown)),
    ]));
  }

  function guestForm() {
    const input = el("input", { class: "text-input", name: "name", maxlength: MAX_GUEST_NAME, autocomplete: "off", enterkeyhint: "done", "aria-label": "Guest's name", placeholder: "Name" });
    return el("form", { class: "guest-form", "data-guest-form": true, novalidate: true }, [
      el("span", { class: "av is-guest", "aria-hidden": "true" }, icon("plus")),
      input,
      el("button", { type: "button", class: "icon-btn", "data-cancel": true, "aria-label": "Cancel" }, icon("close")),
      el("button", { type: "submit", class: "icon-btn go", "aria-label": "Add guest" }, icon("check")),
      el("p", { class: "field-msg", role: "status" }),
    ]);
  }

  function renderPeople(v) {
    const canAdd = v.s.status === "draft" && v.onBill && !stopped;
    if (!canAdd) addingGuest = false;
    for (const list of root.querySelectorAll("[data-people] > ul.people")) {
      const roster = JSON.stringify([v.s.participants, v.s.owing, v.s.result.shares, v.s.payerId, v.s.viewer, v.s.status]);
      const entries = membersFirst(v).map((p) => ({ id: "p:" + p.id, key: roster, build: () => tileNode(v, p) }));
      if (canAdd) {
        entries.push({
          id: "add",
          key: String(addingGuest),
          build: () => addingGuest
            ? el("li", { class: "guest-form-slot", "data-add-guest-slot": true }, guestForm())
            : el("li", { "data-add-guest-slot": true }, el("button", { type: "button", class: "tile add-tile", "data-add-guest": true }, [
                el("span", { class: "avw" }, el("span", { class: "av", "aria-hidden": "true" }, icon("plus"))),
                el("span", { class: "tile-name" }, "Guest"),
                el("span", { class: "tile-amt" }, " "),
              ])),
        });
      }
      patch(list, entries);
    }
  }

  // ---- the footer ---------------------------------------------------------

  // Mirrors owes in page.ts.
  function renderOwes(v) {
    const row = root.querySelector("[data-bar] > [data-owes]");
    if (!row) return;
    const ids = [v.s.viewer].concat(guestsOf(v, v.s.viewer).map((g) => g.id));
    const pick = editable(v.s) !== "none" && ids.length > 1;
    const actor = claimFor || v.s.viewer;
    const owed = (id) => (v.shares.get(id) ? v.shares.get(id).owedCents : 0);
    if (pick) {
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", "Claim for");
    } else {
      row.removeAttribute("role");
      row.removeAttribute("aria-label");
    }
    keyedInto(row, JSON.stringify([ids.map((id) => [id, nameOf(v, id), owed(id)]), pick, actor]), () => ids.map((id) => {
      const mark = pick ? el("span", { class: "mark", "aria-hidden": "true" }, icon("check")) : null;
      const cls = id === v.s.viewer ? "owe" : "owe is-guest";
      const inner = [el("span", { class: "owe-av" }, [av(v, id), mark]), el("span", { class: "owe-text" }, [
        el("span", { class: "owe-label" }, id === v.s.viewer ? "You owe" : nameOf(v, id) + " owes"),
        el("span", { class: "amount money", "data-you-owed": id === v.s.viewer ? true : null }, money(owed(id))),
      ])];
      return pick
        ? el("button", { type: "button", class: cls, "data-claim-as": id, "aria-pressed": String(id === actor) }, inner)
        : el("div", { class: cls }, inner);
    }));
  }

  // ---- the confirmed bill -------------------------------------------------

  function counted(v, id) {
    const guests = guestsOf(v, id).filter((g) => debtorOf(g, v.s.payerId) === id && g.paidToPayer !== true).map((g) => g.id);
    return sharesOf(v, [id].concat(guests)).filter((x) => !x.pardoned);
  }

  // The bar draws what is paid, so the discount comes out of the food it was
  // taken off rather than getting a segment of its own.
  function splitNodes(shares) {
    const parts = shares.reduce((n, x) => ({
      food: n.food + x.subtotalCents,
      discount: n.discount + x.discountCents,
      tax: n.tax + x.taxCents,
      tip: n.tip + x.tipCents,
    }), { food: 0, discount: 0, tax: 0, tip: 0 });
    const off = parts.discount !== 0;
    const seg = (cls, cents) => (cents > 0 ? el("span", { class: cls, style: "flex:" + cents }) : null);
    const label = "Food " + money(parts.food) + ", " + (off ? "Discount " + money(-parts.discount) + ", " : "") + "Tax " + money(parts.tax) + ", Tip " + money(parts.tip);
    return [
      el("div", { class: "split-bar", role: "img", "aria-label": label },
        [seg("food", parts.food - parts.discount), seg("tax", parts.tax), seg("tip", parts.tip)]),
      el("p", { class: "legend parts", "data-you-detail": true }, [
        el("span", null, [el("span", { class: "part-name" }, [el("span", { class: "key food", "aria-hidden": "true" }), icon("bowl"), sr("Food")]), el("span", { class: "money" }, money(parts.food))]),
        off ? el("span", null, [el("span", { class: "part-name" }, "Discount "), el("span", { class: "money" }, money(-parts.discount))]) : null,
        el("span", null, [el("span", { class: "part-name" }, [el("span", { class: "key tax", "aria-hidden": "true" }), "Tax "]), el("span", { class: "money" }, money(parts.tax))]),
        el("span", null, [el("span", { class: "part-name" }, [el("span", { class: "key tip", "aria-hidden": "true" }), "Tip "]), el("span", { class: "money" }, money(parts.tip))]),
      ]),
    ];
  }

  function pie(done, total) {
    const c = 2 * Math.PI * 22;
    const f = total > 0 ? Math.min(1, done / total) : 0;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("class", "pie");
    svg.setAttribute("viewBox", "0 0 54 54");
    svg.setAttribute("aria-hidden", "true");
    const circle = (cls, dash) => {
      const node = document.createElementNS(SVG, "circle");
      node.setAttribute("class", cls);
      node.setAttribute("cx", "27");
      node.setAttribute("cy", "27");
      node.setAttribute("r", "22");
      if (dash) node.setAttribute("stroke-dasharray", dash);
      return node;
    };
    svg.append(circle("track"));
    if (f > 0) svg.append(circle("done", (c * f).toFixed(1) + " " + c.toFixed(1)));
    return svg;
  }

  function payNodes(v) {
    if (!v.s.pay) return null;
    const link = (kind, url) => el("a", { class: "pay " + kind, href: url }, ["Venmo", icon("out")]);
    return el("div", { class: "pay-row", "data-pay": true }, [link("is-app", v.s.pay.appUrl), link("is-web", v.s.pay.webUrl)]);
  }

  function collected(done, total) {
    return el("p", { class: "legend" }, el("span", null, [
      el("span", { class: "money" }, money(total)), " owed to you · ", el("span", { class: "money" }, money(done)), " paid",
    ]));
  }

  function heroNodes(v) {
    const s = v.s;
    if (s.viewerIsPayer) {
      const debtors = Object.keys(s.owing).filter((id) => id !== s.viewer && owedOf(v, id) > 0);
      const total = debtors.reduce((n, id) => n + owedOf(v, id), 0);
      const left = debtors.reduce((n, id) => n + leftOf(v, id), 0);
      return [
        el("div", { class: "flow" }, [stack(v, debtors, 4), icon("arrow", "arrow"), av(v, s.viewer)]),
        el("p", { class: "hero-cap" }, "to collect"),
        el("div", { class: "collect" }, [el("p", { class: "hero-amt money", "data-you-owed": true }, money(left)), pie(total - left, total)]),
        collected(total - left, total),
      ];
    }
    const mine = [s.viewer].concat(guestsOf(v, s.viewer).filter((g) => g.paidToPayer !== true).map((g) => g.id));
    const forgiven = forgivenWhole(v, s.viewer);
    const mixed = guestsOf(v, s.viewer).length > 0;
    const paid = paidUp(v, s.viewer);
    return [
      el("div", { class: "flow" }, [stack(v, mine, 3), icon("arrow", "arrow"), av(v, s.payerId)]),
      forgiven ? el("p", { class: "was money" }, money(sharesOf(v, mine).reduce((n, x) => n + x.owedCents, 0))) : null,
      el("p", { class: "hero-amt money", "data-you-owed": true }, money(paid || forgiven ? 0 : leftOf(v, s.viewer))),
      paid ? el("span", { class: "stamp" + (justPaid ? (slamming ? " is-pressed is-after-slam" : " is-pressed") : ""), role: "img", "aria-label": "Paid" }, "付讫") : null,
      !paid && forgiven ? el("span", { class: "gift-mark", role: "img", "aria-label": "Forgiven" }, icon("gift")) : null,
      whoNodes(v),
    ].concat(forgiven || mixed ? [] : splitNodes(counted(v, s.viewer)))
      .concat([payActs(paid ? null : payNodes(v), sentNodes(v))]);
  }

  function payActs(pay, sent) {
    return pay || sent ? el("div", { class: "pay-acts" }, [pay, sent]) : null;
  }

  function whoNodes(v) {
    const s = v.s;
    const guests = guestsOf(v, s.viewer);
    if (guests.length === 0) return null;
    const row = (id, name, paid, off) => {
      const share = v.shares.get(id);
      const forgiven = Boolean(share && share.pardoned);
      return el("li", off ? { class: "is-off" } : null, [
        av(v, id),
        el("span", { class: "name" }, name),
        paid ? el("span", { class: "stamp", role: "img", "aria-label": "Paid" }, "付讫") : null,
        el("span", { class: "note" }, forgiven ? "forgiven" : ""),
        el("span", { class: "money" + (forgiven ? " is-forgiven is-off" : off ? " is-off" : "") }, money(share ? share.owedCents : 0)),
      ]);
    };
    return el("ul", { class: "whose", "data-who": true, "aria-label": "Whose share" }, [row(s.viewer, "You", false, false)].concat(guests.map((g) =>
      row(g.id, g.displayName, guestPaid(v, g), g.paidToPayer === true))));
  }

  function sentNodes(v) {
    if (leftOf(v, v.s.viewer) <= 0) return null;
    return el("div", { class: "sent-row needs-js", "data-sent": true },
      el("button", { type: "button", class: "sent", "data-pay-all": true, "aria-busy": busy.has("sent") ? "true" : null }, [icon("check"), "I paid"]));
  }

  let wasPaid = null;
  let justPaid = false;
  // Set before the payment is sent, because the hero redraws with the
  // answer, before the big stamp is put down.
  let slamming = false;
  const SLAM_MS = 1000;

  function slam(seal) {
    const mark = el("div", { class: "slam", "aria-hidden": "true" }, seal);
    document.body.appendChild(mark);
    setTimeout(() => {
      mark.remove();
      slamming = false;
    }, SLAM_MS);
  }

  function renderHero(v) {
    const hero = root.querySelector("section.hero[data-you]");
    if (!hero) return;
    const paid = paidUp(v, v.s.viewer);
    justPaid = wasPaid === false && paid;
    wasPaid = paid;
    hero.classList.toggle("is-paid", paid);
    hero.classList.toggle("is-forgiven", !v.s.viewerIsPayer && forgivenWhole(v, v.s.viewer));
    keyedInto(hero, JSON.stringify([v.s.owing, v.s.pay, v.s.result.shares, v.s.participants, v.s.payerId, busy.has("sent")]), () => heroNodes(v));
  }

  // Mirrors taxTipRows on the server.
  function taxTipNodes(v, id) {
    const share = v.shares.get(id);
    if (!share) return [];
    const row = (label, cents) => el("li", { class: "tax-tip" }, [el("span", { class: "item-label" }, label), el("span", { class: "money" }, money(cents))]);
    return (share.discountCents !== 0 ? [row("Discount", -share.discountCents)] : []).concat([row("Tax", share.taxCents), row("Tip", share.tipCents)]);
  }

  function mineNodes(v, id, withTaxTip) {
    const rows = v.s.items.filter((i) => i.claimedBy.includes(id)).map((item) => {
      const n = item.claimedBy.length;
      return el("li", null, [
        el("span", { class: "item-label" }, item.label),
        n > 1 ? el("span", { class: "piece" }, "÷" + n) : null,
        el("span", { class: "money" }, money(piecesOf(item).get(id) || 0)),
      ]);
    });
    return rows.length > 0 ? el("ul", null, rows.concat(withTaxTip ? taxTipNodes(v, id) : [])) : null;
  }

  function renderMine(v) {
    const card = root.querySelector("[data-mine]");
    if (!card) return;
    keyedInto(card, JSON.stringify([v.s.items, v.s.participants, v.s.payerId, v.s.result.shares]), () => {
      const groups = [];
      const withTaxTip = guestsOf(v, v.s.viewer).length > 0;
      for (const g of guestsOf(v, v.s.viewer)) {
        const list = mineNodes(v, g.id, withTaxTip);
        if (list) groups.push(el("div", { class: "mine-group" }, [el("p", { class: "mine-guest" }, [av(v, g.id), g.displayName]), list]));
      }
      const own = mineNodes(v, v.s.viewer, withTaxTip);
      const yours = own && (groups.length > 0 || v.s.viewerIsPayer)
        ? el("div", { class: "mine-group" }, [el("p", { class: "mine-guest" }, [av(v, v.s.viewer), "You"]), own])
        : own;
      return [yours].concat(groups);
    });
  }

  function renderDrill(v) {
    const people = root.querySelector('[data-go="people"]');
    if (!people) return;
    const debtors = Object.keys(v.s.owing).filter((id) => id !== v.s.payerId && owedOf(v, id) > 0);
    const done = debtors.filter((id) => paidUp(v, id)).length;
    keyedInto(people, JSON.stringify([v.s.participants, done, debtors.length]), () => [
      icon("people"),
      el("span", { class: "grow" }, stack(v, membersFirst(v).map((p) => p.id), 6)),
      debtors.length > 0 ? el("span", { class: "count" }, done + " of " + debtors.length + " paid") : null,
      icon("chev"),
    ]);
    const total = root.querySelector('[data-go="receipt"] .money');
    if (total) total.textContent = money(v.s.result.distributableCents);
  }

  // ---- what can be done to the bill ----------------------------------------

  function confirmBlock(s) {
    if (s.printedTotalCents === null) return "Enter the receipt total first.";
    if (!s.reconciles.ok) return "Line items do not add up to total!";
    if (!s.items.some((i) => i.claimedBy.length > 0)) return "Nobody has claimed anything yet.";
    return null;
  }

  function openLines(s) {
    return s.items.filter((i) => i.claimedBy.length === 0);
  }

  function editingPrinted() {
    return Boolean(editing && editing.kind === "field" && editing.field === "printedTotal");
  }

  // Mirrors printedRow in page.ts. The form is kept across redraws of the
  // card, like a sheet's, so a poll never wipes what is being typed.
  function printedNodes(v) {
    if (editingPrinted()) {
      if (!editing.form) editing.form = fieldForm(v.s, "printedTotal");
      return el("div", { class: "trow is-editing", "data-field-row": "printedTotal" }, editing.form);
    }
    if (v.s.reconciles.ok) return null;
    return el("div", { class: "trow", "data-field-row": "printedTotal" }, [
      el("dt", null, "Receipt total"),
      el("dd", null, amount(editable(v.s), "printedTotal", "printed", v.s.printedTotalCents, "Receipt total")),
    ]);
  }

  function confirmNodes(v) {
    const blocked = confirmBlock(v.s);
    const open = openLines(v.s).length;
    const why = blocked || (open === 0 ? "" : open === 1 ? "1 line has nobody on it." : open + " lines have nobody on them.");
    return el("div", { class: "confirm-area" }, [
      printedNodes(v),
      el("button", {
        type: "button",
        class: "confirm-btn",
        "data-confirm": true,
        disabled: Boolean(blocked) || stopped,
        "aria-busy": busy.has("confirm") ? "true" : null,
        "aria-describedby": why ? "confirm-why" : null,
      }, [
        el("span", { class: "seal", "aria-hidden": "true" }, "定"),
        el("span", { class: "confirm-text" }, [
          el("span", { class: "confirm-word" }, "Confirm"),
          why ? el("span", { class: "why" + (blocked ? "" : " is-hint"), id: "confirm-why", "aria-hidden": "true" }, why) : null,
        ]),
      ]),
    ]);
  }

  function act(attrs, iconName, title, sub, cls, chev) {
    return el("button", Object.assign({ type: "button", class: "act" + (cls ? " " + cls : "") }, attrs), [
      icon(iconName),
      el("span", { class: "grow" }, [el("span", null, title), sub ? el("span", { class: "act-sub" }, sub) : null]),
      chev ? icon("chev") : null,
    ]);
  }

  // Mirrors venmoAct on the server.
  function venmoAct(v) {
    const s = v.s;
    if (!v.people.has(s.viewer)) return null;
    const saved = s.viewerVenmo;
    const ask = s.viewerIsPayer && s.status === "draft" && !saved;
    return act({ "data-venmo": true, "aria-haspopup": "dialog" }, "coin",
      ask ? "How should friends pay you back?" : "Your Venmo",
      ask ? "Add your Venmo." : saved ? "@" + saved : "Add it so friends can pay you back.", "", true);
  }

  function actionNodes(v) {
    const s = v.s;
    if (s.viewerIsPayer) {
      return [
        venmoAct(v),
        s.status === "draft" ? confirmNodes(v) : null,
        s.status === "confirmed"
          ? act({ "data-reopen": true, "aria-busy": busy.has("reopen") ? "true" : null }, "receipt", "Edit the bill", "Paying pauses until you confirm again.")
          : null,
        act({ "data-delete-bill": true, "aria-busy": busy.has("delete") ? "true" : null }, "basket",
          armed.has("delete-bill") ? "Tap again to delete this bill" : "Delete this bill", null, armed.has("delete-bill") ? "is-armed" : ""),
      ];
    }
    return [
      venmoAct(v),
      s.status === "confirmed"
        ? act({ "data-ask": "wrong", "aria-haspopup": "dialog" }, "warn", "Something's wrong", "Paying pauses until " + nameOf(v, s.payerId) + " fixes it.", "is-warn")
        : null,
    ];
  }

  function renderActions(v) {
    const card = root.querySelector("[data-actions]");
    if (!card) return;
    const s = v.s;
    keyedInto(card, JSON.stringify([s.status, s.items, s.printedTotalCents, s.reconciles, s.participants, s.payerId, s.viewerVenmo, Array.from(busy), Array.from(armed), editingPrinted(), stopped]), () => actionNodes(v));
  }

  // Mirrors paidBy on the server.
  function paidBy(v) {
    const paid = new Map();
    for (const p of v.s.payments) paid.set(p.participant, (paid.get(p.participant) || 0) + p.cents);
    return v.s.participants.flatMap((p) => {
      const share = v.shares.get(p.id);
      const asked = p.id in v.s.owing ? owedOf(v, p.id) : share && !share.pardoned ? share.owedCents : 0;
      return asked > 0 && (paid.get(p.id) || 0) >= asked ? [{ id: p.id, cents: asked }] : [];
    });
  }

  function paymentNodes(rows, v) {
    if (rows.length === 0) return [];
    return [
      el("h2", null, "Payments"),
      el("ul", null, rows.map((r) => {
        const name = nameOf(v, r.id);
        return el("li", null, [
          av(v, r.id),
          el("span", { class: "name" }, name),
          el("span", { class: "money" }, money(r.cents)),
          el("span", { class: "stamp", role: "img", "aria-label": "Paid" }, "付讫"),
          el("button", {
            type: "button",
            class: "chip-btn",
            "data-undo-paid": r.id,
            "aria-busy": busy.has("undo:" + r.id) ? "true" : null,
            "aria-label": "Undo " + name + "'s payment",
          }, "Undo"),
        ]);
      })),
    ];
  }

  function renderPayments(v) {
    const card = root.querySelector("[data-payments]");
    if (!card) return;
    const rows = paidBy(v);
    card.hidden = rows.length === 0;
    keyedInto(card, JSON.stringify([rows, v.s.participants, Array.from(busy)]), () => paymentNodes(rows, v));
  }

  // A confirmed bill has three views on one page: your share, the receipt
  // and the people. Each is a hash, so the phone's back gesture works.
  let viewName = "home";

  function showView() {
    if (layout !== "share") return;
    const wanted = location.hash === "#receipt" ? "receipt" : location.hash === "#people" ? "people" : "home";
    if (wanted === viewName && root.querySelector(".view.is-active")) return;
    const leaving = viewName;
    viewName = wanted;
    for (const node of root.querySelectorAll(".view")) node.classList.toggle("is-active", node.dataset.view === wanted);
    if (leaving === "home") homeScroll = window.scrollY;
    window.scrollTo(0, wanted === "home" ? homeScroll : 0);
  }
  let homeScroll = 0;
  let pushedView = false;

  // ---- sheets -------------------------------------------------------------

  function sheetNode() {
    let dialog = root.querySelector("dialog[data-sheet]");
    if (!dialog) {
      dialog = el("dialog", { class: "sheet", "data-sheet": true, "aria-labelledby": "sheet-title" });
      dialog.addEventListener("close", () => {
        sheet = null;
        for (const key of Array.from(armed)) if (key !== "delete-bill") armed.delete(key);
        dialog.replaceChildren();
        dialog._key = undefined;
        render();
        if (dialog._return && document.contains(dialog._return)) dialog._return.focus();
      });
      root.append(dialog);
    }
    return dialog;
  }

  function openSheet(next, from) {
    sheet = next;
    const dialog = sheetNode();
    dialog._key = undefined;
    dialog._return = from || null;
    render();
    if (!dialog.open) dialog.showModal();
    const first = dialog.querySelector("[data-autofocus]") || dialog.querySelector(".close");
    if (first) first.focus();
  }

  function closeSheet() {
    const dialog = root.querySelector("dialog[data-sheet]");
    if (dialog && dialog.open) dialog.close();
  }

  function sheetHead(v, id, title, amountText, extra, doomed) {
    return el("div", { class: "sheet-head" + (doomed ? " is-struck" : "") }, [
      av(v, id),
      el("h2", { id: "sheet-title" }, el("span", { class: "struck" }, title)),
      amountText === null ? null : el("span", { class: "money" }, amountText),
      extra || null,
      el("button", { type: "button", class: "icon-btn close", "data-close-sheet": true, "aria-label": "Close" }, icon("close")),
    ]);
  }

  function linesOf(v, id) {
    const rows = v.s.items.filter((i) => i.claimedBy.includes(id)).map((item) => {
      const n = item.claimedBy.length;
      return el("li", null, [
        el("span", { class: "item-label" }, item.label),
        n > 1 ? el("span", { class: "piece" }, "÷" + n) : null,
        el("span", { class: "money" }, money(piecesOf(item).get(id) || 0)),
      ]);
    });
    return el("ul", { class: "sheet-lines" }, rows.length > 0 ? rows.concat(taxTipNodes(v, id)) : [el("li", { class: "empty" }, "Nothing claimed yet.")]);
  }

  function forgiveButton(v, p) {
    const share = v.shares.get(p.id);
    const debtor = debtorOf(p, v.s.payerId);
    if (!share || debtor === v.s.payerId) return null;
    const pardoned = share.pardoned;
    return el("button", {
      type: "button",
      class: "chip-btn",
      "data-forgive": p.id,
      "data-pardoned": String(pardoned),
      "aria-label": (pardoned ? "Undo forgiving " : "Forgive ") + p.displayName + "'s share",
      // Busy rather than disabled while its answer is out, so the button
      // keeps keyboard focus across the redraw.
      "aria-busy": busy.has("forgive:" + p.id) ? "true" : null,
      disabled: v.s.paid.includes(debtor) || stopped,
    }, [icon("gift"), pardoned ? "Undo" : "Forgive"]);
  }

  function guestBlock(v, g) {
    const draft = v.s.status === "draft";
    const confirmed = v.s.status === "confirmed";
    const manage = canManageGuest(v, g) && !stopped;
    const share = v.shares.get(g.id);
    const renaming = sheet && sheet.renaming === g.id;
    const doomed = armed.has("remove:" + g.id);
    const head = renaming
      ? el("form", { class: "guest-form", "data-rename": g.id, novalidate: true }, [
          av(v, g.id),
          (() => {
            const input = el("input", { class: "text-input", name: "name", maxlength: MAX_GUEST_NAME, autocomplete: "off", enterkeyhint: "done", "aria-label": "Guest's name", "data-autofocus": true });
            input.value = g.displayName;
            return input;
          })(),
          el("button", { type: "button", class: "icon-btn", "data-cancel": true, "aria-label": "Cancel" }, icon("close")),
          el("button", { type: "submit", class: "icon-btn go", "aria-label": "Save" }, icon("check")),
          el("p", { class: "field-msg", role: "status" }),
        ])
      : el("div", { class: "sheet-head" + (doomed ? " is-struck" : "") }, [
          av(v, g.id),
          el("h3", null, draft && manage
            ? el("button", { type: "button", class: "name-btn", "data-rename-guest": g.id, "aria-label": "Rename " + g.displayName }, [el("span", { class: "struck" }, g.displayName), icon("brush", "brush")])
            : el("span", { class: "struck" }, g.displayName)),
          guestPaid(v, g) ? el("span", { class: "stamp", role: "img", "aria-label": "Paid" }, "付讫") : null,
          share ? el("span", { class: "money" + (share.pardoned ? " was" : "") }, money(share.owedCents)) : null,
        ]);
    const actions = [];
    if (draft && manage) {
      actions.push(el("button", { type: "button", class: "chip-btn" + (doomed ? " is-armed" : ""), "data-remove-guest": g.id },
        [icon("basket"), doomed ? "Tap again to remove" : "Remove", el("span", { class: "target" }, g.displayName)]));
    }
    // A guest already paid, directly or with their member, has nothing left
    // to mark, so the chip stays only to take back the viewer's own mark.
    if (confirmed && manage && (ownMark(v, g) || !guestPaid(v, g))) {
      actions.push(el("button", {
        type: "button",
        class: "chip-btn",
        "data-guest-paid": g.id,
        "aria-pressed": String(ownMark(v, g)),
        "aria-busy": busy.has("paid:" + g.id) ? "true" : null,
      }, [el("span", { "aria-hidden": "true", style: "font-family: var(--brush)" }, "付讫"), "Paid"]));
    }
    if (confirmed && v.s.viewerIsPayer) actions.push(forgiveButton(v, g));
    return el("div", { class: "sheet-guest" }, [head, linesOf(v, g.id)]
      .concat(actions.filter(Boolean).length > 0 ? [el("div", { class: "sheet-actions" }, actions.filter(Boolean))] : []));
  }

  function personSheet(v, id) {
    const p = v.people.get(id);
    if (!p) return null;
    const guests = guestsOf(v, id);
    // With guests, each block heads its own lines, so this one says the
    // person's own share and the guests' blocks say theirs. Together they
    // make the amount on the tile.
    const own = v.shares.get(id);
    const head = guests.length > 0 && own ? own.owedCents : owedOf(v, id);
    const doomed = armed.has("remove:" + id);
    const nodes = [
      sheetHead(v, id, p.displayName, money(head), paidUp(v, id) ? el("span", { class: "stamp", role: "img", "aria-label": "Paid" }, "付讫") : null, doomed),
    ];
    // Each block of lines ends in its own discount, tax and tip rows, figures
    // on the right like the lines above, so it adds up to its heading.
    nodes.push(linesOf(v, id));
    if (v.s.status === "confirmed" && v.s.viewerIsPayer) {
      const forgive = forgiveButton(v, p);
      if (forgive) nodes.push(el("div", { class: "sheet-actions" }, forgive));
    }
    if (id === v.s.viewer && v.s.status === "draft" && guests.length === 0 && !stopped) {
      nodes.push(el("div", { class: "sheet-actions" }, el("button", { type: "button", class: "chip-btn", "data-add-guest": true }, [icon("plus"), "Guest"])));
    }
    for (const g of guests) nodes.push(guestBlock(v, g));
    if (canRemove(v, p)) {
      nodes.push(el("div", { class: "sheet-actions" }, el("button", { type: "button", class: "chip-btn" + (doomed ? " is-armed" : ""), "data-remove-member": id },
        [icon("basket"), doomed ? "Tap again to remove" : "Remove", el("span", { class: "target" }, p.displayName)])));
    }
    nodes.push(el("p", { class: "sheet-msg", role: "status" }, sheet.msg || ""));
    return nodes;
  }

  // The rules removeMember holds on the server, so the button only shows when
  // it would work. Someone's guests have to come off first, in this same sheet.
  function canRemove(v, p) {
    const s = v.s;
    return s.viewerIsPayer && s.status === "draft" && p.kind === "member" && p.id !== s.payerId && !stopped
      && guestsOf(v, p.id).length === 0 && !(s.payments || []).some((x) => x.participant === p.id);
  }

  // One node for the sheet's life, like a line's form, so a redraw keeps what
  // has been typed. On the nudge, "Confirm anyway" sits here too, and it never
  // needs the field to be right.
  function venmoForm(nudge) {
    const input = el("input", {
      class: "text-input",
      name: "username",
      autocomplete: "off",
      autocapitalize: "none",
      autocorrect: "off",
      spellcheck: "false",
      enterkeyhint: "done",
      placeholder: "venmo-username",
      "aria-label": "Venmo username",
      "data-autofocus": !nudge,
    });
    input.value = state.viewerVenmo || "";
    const field = el("span", { class: "handle-field" }, [el("span", { class: "at", "aria-hidden": "true" }, "@"), input]);
    const msg = el("p", { class: "field-msg", role: "status" });
    return el("form", { class: "handle-form", "data-venmo-form": nudge ? "confirm" : "", novalidate: true }, nudge
      ? [field, msg, el("div", { class: "sheet-actions" }, [
          el("button", { type: "button", class: "chip-btn sheet-go", "data-confirm-anyway": true }, "Confirm anyway"),
          el("button", { type: "submit", class: "chip-btn sheet-go is-seal" }, "Save and confirm"),
        ])]
      : [field, el("button", { type: "submit", class: "chip-btn go" }, [icon("check"), "Save"]), msg]);
  }

  function venmoSheet() {
    return [
      askHead("Your Venmo"),
      el("p", { class: "sheet-body" }, "Friends pay you here when you cover a bill."),
      sheet.form,
    ];
  }

  function nudgeSheet() {
    return [
      askHead("Add your Venmo first?"),
      el("p", { class: "sheet-body" }, "Friends get a Venmo button once you do."),
      sheet.form,
    ];
  }

  function pickNode(v, item, p) {
    const pressed = item.claimedBy.includes(p.id);
    return el("button", {
      type: "button",
      class: "tile pick",
      "data-claim": true,
      "data-item": item.id,
      "data-participant": p.id,
      "aria-pressed": String(pressed),
      "aria-label": p.displayName,
    }, [
      el("span", { class: "avw" }, [av(v, p.id), el("span", { class: "tick", "aria-hidden": "true" }, icon("check"))]),
      el("span", { class: "tile-name" }, p.displayName),
    ]);
  }

  // A dish on the bill edits as its own price plus one row per add-on, so a
  // wrongly read add-on is removed or repriced and the total follows. Adding
  // a line from the receipt stays a name and a price.
  function lineForm(item) {
    const n = Date.now();
    const addons = item ? item.addons || [] : [];
    const base = item ? item.cents - addons.reduce((sum, a) => sum + a.cents, 0) : 0;
    const label = el("input", { id: "line-name-" + n, class: "text-input", name: "label", maxlength: MAX_LABEL, autocomplete: "off", enterkeyhint: "next", "aria-label": "Name", placeholder: item ? null : "Name" });
    const price = el("input", { id: "line-price-" + n, name: "price", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", "aria-label": item ? null : "Price", placeholder: "0.00" });
    if (item) {
      label.value = item.label;
      price.value = plain(base);
    }
    const form = el("form", { class: "line-form" + (item ? " dish-form" : ""), novalidate: true }, [
      label,
      item ? el("label", { class: "field-label", for: price.id, "data-base-label": true }) : null,
      moneyInput(price, base),
      item ? el("p", { class: "addons-head", "data-addons-head": true }, "Add-ons") : null,
      ...addons.map((a) => addonRow(a)),
      item ? el("button", { type: "button", class: "add-row", "data-add-addon": true }, [icon("plus"), "Add-on"]) : null,
      item ? el("p", { class: "dish-sum", "data-dish-sum": true }, [el("span", null, "Total"), el("span", { class: "money", "data-dish-total": true })]) : null,
      el("p", { class: "field-msg", role: "status" }),
      el("div", { class: "actions" }, [
        item ? deleteLineButton(item, false) : null,
        item ? null : el("button", { type: "button", class: "icon-btn", "data-cancel": true, "aria-label": "Cancel" }, icon("close")),
        el("button", { type: "submit", class: "chip-btn go" }, [icon("check"), item ? "Save" : "Add line"]),
      ]),
    ]);
    form._addons = JSON.stringify(addons.map((a) => [a.label, a.cents]));
    if (item) {
      form.dataset.editLine = item.id;
      refreshDish(form);
    } else form.dataset.addLine = "";
    return form;
  }

  // The form outlives redraws of its sheet, so arming swaps this button in
  // place rather than waiting for a render to rebuild it.
  function deleteLineButton(item, doomed) {
    return el("button", { type: "button", class: "chip-btn" + (doomed ? " is-armed" : ""), "data-delete-line": item.id, "aria-label": (doomed ? "Tap again to delete " : "Delete ") + item.label },
      [icon("basket"), doomed ? "Tap again to delete" : "Delete line"]);
  }

  function addonRow(addon) {
    const name = el("input", { class: "text-input", "data-addon-label": true, maxlength: MAX_ADDON_LABEL, autocomplete: "off", enterkeyhint: "next", "aria-label": "Add-on", placeholder: "Add-on" });
    const price = el("input", { "data-addon-price": true, inputmode: "decimal", autocomplete: "off", enterkeyhint: "done", "aria-label": addon.cents < 0 ? "Add-on money off" : "Add-on price", placeholder: "0.00" });
    name.value = addon.label;
    price.value = addon.cents === 0 ? "" : plain(Math.abs(addon.cents));
    return el("div", { class: "addon", "data-addon": true }, [
      el("span", { class: "addon-field" }, [
        name,
        el("button", { type: "button", class: "icon-btn", "data-remove-addon": true, "aria-label": "Remove add-on" }, icon("close")),
      ]),
      moneyInput(price, addon.cents),
    ]);
  }

  // The dish as it would save. A price that doesn't read as money yet counts
  // as nothing until it does.
  function dishCents(form) {
    const base = amountOf(form.elements.price);
    let cents = base === null ? 0 : signedHundredths(base);
    for (const input of form.querySelectorAll("[data-addon-price]")) {
      const value = addonPrice(input);
      if (value !== null) cents += signedHundredths(value);
    }
    return cents;
  }

  function refreshDish(form) {
    const addons = form.querySelectorAll("[data-addon]");
    const rows = addons.length;
    for (const row of addons) {
      const name = row.querySelector("[data-addon-label]").value.trim();
      row.querySelector("[data-remove-addon]").setAttribute("aria-label", "Remove " + (name || "add-on"));
    }
    form.querySelector("[data-base-label]").textContent = form.elements.price.dataset.off !== undefined ? "Money off" : rows > 0 ? "Base price" : "Price";
    form.querySelector("[data-addons-head]").hidden = rows === 0;
    form.querySelector("[data-add-addon]").hidden = rows >= MAX_ADDONS;
    form.querySelector("[data-dish-sum]").hidden = rows === 0;
    form.querySelector("[data-dish-total]").textContent = money(dishCents(form));
  }

  function lineSheet(v, itemId) {
    const item = v.s.items.find((i) => i.id === itemId);
    if (!item) return null;
    const people = membersFirst(v).reduce((all, p) => all.concat([p], guestsOf(v, p.id)), []);
    return [
      el("div", { class: "sheet-head" + (armed.has("line:" + item.id) ? " is-struck" : "") }, [
        el("h2", { id: "sheet-title", class: "dish-title" }, el("span", { class: "struck" }, item.label)),
        el("button", { type: "button", class: "icon-btn close", "data-close-sheet": true, "aria-label": "Close" }, icon("close")),
      ]),
      el("div", { class: "picker", role: "group", "aria-label": "Who had " + item.label }, people.map((p) => pickNode(v, item, p))),
      sheet.form,
    ];
  }

  function payerSheet(v) {
    const members = membersFirst(v);
    const picked = sheet.picked || v.s.payerId;
    return [
      el("div", { class: "sheet-head" }, [
        el("span", { class: "payer-chip" }, icon("coin")),
        el("h2", { id: "sheet-title" }, nameOf(v, picked)),
        el("button", { type: "button", class: "icon-btn close", "data-close-sheet": true, "aria-label": "Close" }, icon("close")),
      ]),
      el("div", { class: "picker", role: "group", "aria-label": "Who paid" }, members.map((p) => el("button", {
        type: "button",
        class: "tile pick",
        "data-pick-payer": p.id,
        "aria-pressed": String(p.id === picked),
        "aria-label": p.displayName,
      }, [el("span", { class: "avw" }, [av(v, p.id), el("span", { class: "tick", "aria-hidden": "true" }, icon("check"))]), el("span", { class: "tile-name" }, p.displayName)]))),
      el("div", { class: "sheet-actions" }, el("button", { type: "button", class: "chip-btn", "data-save-payer": true, disabled: picked === v.s.payerId || stopped, style: "margin-left: auto" }, [icon("check"), nameOf(v, picked)])),
      el("p", { class: "sheet-msg", role: "status" }, sheet.msg || ""),
    ];
  }

  function askHead(title) {
    return el("div", { class: "sheet-head" }, [
      el("h2", { id: "sheet-title" }, title),
      el("button", { type: "button", class: "icon-btn close", "data-close-sheet": true, "aria-label": "Close" }, icon("close")),
    ]);
  }

  function goButton(label, tone) {
    return el("button", {
      type: "button",
      class: "chip-btn sheet-go is-" + tone,
      "data-do": sheet.kind,
      disabled: stopped,
      "aria-busy": busy.has(sheet.kind) ? "true" : null,
    }, label);
  }

  function cancelButton(label) {
    // Focus lands on the way out, so a stray Enter never reopens or confirms.
    return el("button", { type: "button", class: "chip-btn sheet-go", "data-close-sheet": true, "data-autofocus": true }, label || "Cancel");
  }

  // Each ask says what happens in a plain sentence, then does it on a
  // second, deliberate tap. Deletes skip the sheet and arm in place instead,
  // and undo acts on one tap.
  function askSheet(v) {
    const s = v.s;
    const payer = nameOf(v, s.payerId);
    let title;
    let body;
    let go;
    if (sheet.kind === "wrong") {
      title = "Something's wrong?";
      body = "Paying pauses for everyone until " + payer + " fixes the bill and confirms it again. The channel is told.";
      go = goButton("Tell " + payer, "ink");
    } else {
      const n = openLines(s).length;
      title = n === 1 ? "1 line has nobody on it" : n + " lines have nobody on them";
      body = "Split " + (n === 1 ? "it" : "them") + " evenly between everyone who claimed something, or go back and claim " + (n === 1 ? "it" : "them") + " first.";
      go = goButton("Split and confirm", "seal");
    }
    return [
      askHead(title),
      el("p", { class: "sheet-body" }, body),
      el("div", { class: "sheet-actions" }, [sheet.kind === "split" ? cancelButton("Back") : cancelButton(), go]),
      el("p", { class: "sheet-msg", role: "status" }, sheet.msg || ""),
    ];
  }

  // An ask is only good for the bill it was asked about: once that moves
  // under it, the sheet closes rather than offer something no longer true.
  function askStale(v) {
    const s = v.s;
    if (sheet.kind === "wrong") return s.status !== "confirmed";
    if (sheet.kind === "nudge") return s.status !== "draft";
    return s.status !== "draft" || openLines(s).length === 0;
  }

  const ASKS = ["wrong", "split", "nudge"];

  function renderSheet(v) {
    const dialog = root.querySelector("dialog[data-sheet]");
    if (!dialog || !sheet) return;
    if (ASKS.includes(sheet.kind) && askStale(v)) return closeSheet();
    if (sheet.kind === "line" && (editable(v.s) !== "all" || !v.s.items.some((i) => i.id === sheet.id))) return closeSheet();
    if (sheet.kind === "payer" && (editable(v.s) !== "all" || v.s.hasPayments)) return closeSheet();
    if (sheet.kind === "person" && !v.people.has(sheet.id)) return closeSheet();
    if (sheet.kind === "line" && !sheet.form) {
      sheet.form = lineForm(v.s.items.find((i) => i.id === sheet.id));
    }
    const key = JSON.stringify([sheet.kind, sheet.id, sheet.renaming || null, sheet.picked || null, sheet.msg || "", Array.from(armed), Array.from(busy),
      v.s.items, v.s.participants, v.s.owing, v.s.result.shares, v.s.paid, v.s.status, editable(v.s), v.s.payments, stopped]);
    const build = sheet.kind === "line"
      ? () => lineSheet(v, sheet.id)
      : sheet.kind === "payer"
        ? () => payerSheet(v)
        : sheet.kind === "venmo"
          ? () => venmoSheet()
          : sheet.kind === "nudge"
            ? () => nudgeSheet()
            : ASKS.includes(sheet.kind)
              ? () => askSheet(v)
              : () => personSheet(v, sheet.id);
    keyedInto(dialog, key, () => el("div", { class: "sheet-in" }, build()));
  }

  // ---- drawing ------------------------------------------------------------

  function render() {
    const s = view();
    const v = model(s);
    if (claimFor && !canClaimFor(v, claimFor)) claimFor = null;
    root.dataset.status = s.status;
    root.dataset.editable = editable(s);
    root.dataset.revision = String(s.revision);
    root.dataset.viewerIsPayer = String(s.viewerIsPayer);
    root.classList.toggle("is-stopped", stopped);
    renderHeader(v);
    renderItems(v);
    renderPeople(v);
    renderOwes(v);
    renderHero(v);
    renderMine(v);
    renderDrill(v);
    renderPayments(v);
    renderActions(v);
    renderSheet(v);
  }

  // The layout and every control on it are drawn for one status and one set
  // of rights, so a change in either gets a fresh page rather than a redraw.
  // What happened rides across the reload so the new page can say it.
  function adopt(next) {
    if (!next || typeof next.revision !== "number" || next.revision < state.revision) return;
    if (next.viewerIsPayer !== state.viewerIsPayer || next.editable !== state.editable || next.status !== state.status) {
      stopped = true;
      clearInterval(timer);
      try {
        sessionStorage.setItem("aazhi:moved", JSON.stringify({ bill: next.billId, from: state.status, to: next.status }));
      } catch (error) {
        // Without storage the new page simply opens without a note.
      }
      location.reload();
      return;
    }
    state = next;
    render();
  }

  function greet() {
    let moved = null;
    try {
      moved = JSON.parse(sessionStorage.getItem("aazhi:moved") || "null");
      sessionStorage.removeItem("aazhi:moved");
    } catch (error) {
      moved = null;
    }
    if (!moved || moved.bill !== state.billId || moved.to !== state.status || moved.from === moved.to) return;
    if (state.status === "confirmed") {
      // The big 定 comes down on the page first, then the small one is left
      // in the header where it landed.
      slam(el("span", { class: "seal" }, "定"));
      const seal = root.querySelector("[data-status-label] .seal");
      if (seal) seal.classList.add("is-pressed", "is-after-slam");
      showNote("定 Confirmed", false);
    } else if (state.status === "draft") {
      showNote("Reopened", false);
    }
  }

  function stop(message) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    claimFor = null;
    editing = null;
    addingGuest = false;
    closeSheet();
    showNote(message, true);
    render();
  }

  function messageOf(response) {
    if (response.data && typeof response.data.error === "string") return response.data.error;
    return response.status === 0
      ? "Couldn't reach AAzhi. Check your connection and try again."
      : "Something went wrong. Try again.";
  }

  async function send(method, path, body) {
    try {
      const response = await fetch(base + path, {
        method,
        cache: "no-store",
        headers: Object.assign({ authorization: "Bearer " + token }, body ? { "content-type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try {
        data = await response.json();
      } catch (error) {
        data = null;
      }
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      return { ok: false, status: 0, data: null };
    }
  }

  // Writes go one at a time, in tap order: two quick taps on one tick must
  // reach the server as on-then-off, never the other way round.
  function write(method, path, body) {
    writes += 1;
    const run = queue.then(() => send(method, path, body));
    queue = run.then(() => undefined);
    return run.then((response) => {
      writes -= 1;
      if (response.ok) {
        adopt(response.data);
        return null;
      }
      const message = messageOf(response);
      if (response.status === 403 || response.status === 410) stop(message);
      else if (response.status === 409) {
        showNote(message, true);
        setTimeout(poll, 0);
      } else if (response.status === 404) setTimeout(poll, 0);
      return { message, status: response.status };
    });
  }

  async function poll() {
    if (stopped || polling || writes > 0 || document.visibilityState !== "visible") return;
    polling = true;
    const response = await send("GET", "/state");
    polling = false;
    if (stopped) return;
    if (response.ok) adopt(response.data);
    else if (response.status === 403 || response.status === 404 || response.status === 410) stop(messageOf(response));
  }

  // ---- doing --------------------------------------------------------------

  function onClaim(button) {
    if (stopped) return;
    const op = {
      itemId: button.dataset.item,
      participantId: button.dataset.participant,
      claimed: button.getAttribute("aria-pressed") !== "true",
    };
    pending.push(op);
    render();
    if (op.claimed) {
      const row = root.querySelector('li.item[data-item="' + CSS.escape(op.itemId) + '"]');
      if (row) {
        row.classList.remove("is-inked");
        void row.offsetWidth;
        row.classList.add("is-inked");
      }
    }
    write("POST", "/claim", op).then((failure) => {
      pending.splice(pending.indexOf(op), 1);
      if (failure && !stopped && failure.status !== 409) {
        showNote(failure.status === 0 ? "Couldn't reach AAzhi. Tap again." : failure.message, true);
      }
      render();
    });
  }

  function readLineForm(form) {
    const msg = form.querySelector(".field-msg");
    const label = form.elements.label.value.trim();
    if (label.length === 0 || label.length > MAX_LABEL) {
      msg.textContent = "Give the line a name.";
      form.elements.label.focus();
      return null;
    }
    const price = amountOf(form.elements.price);
    if (price === null) {
      msg.textContent = "Enter the price like 12.50.";
      form.elements.price.focus();
      return null;
    }
    const values = { label, price };
    if (form.dataset.editLine === undefined) return values;
    const addons = [];
    for (const row of form.querySelectorAll("[data-addon]")) {
      const name = row.querySelector("[data-addon-label]");
      const amount = row.querySelector("[data-addon-price]");
      const addonLabel = name.value.replace(/\s+/g, " ").trim();
      const addonValue = addonPrice(amount);
      if (addonLabel === "" && addonValue !== null && hundredths(addonValue.replace("-", "")) === 0) continue;
      if (addonLabel === "") {
        msg.textContent = "Name the add-on.";
        name.focus();
        return null;
      }
      if (addonValue === null) {
        msg.textContent = "Enter the add-on's price like 3.00.";
        amount.focus();
        return null;
      }
      addons.push({ label: addonLabel, price: addonValue });
    }
    // Sent only when changed, so add-ons read off the receipt that are longer
    // than the field allows can stay as they are.
    if (JSON.stringify(addons.map((a) => [a.label, signedHundredths(a.price)])) !== form._addons) values.addons = addons;
    return values;
  }

  function setBusy(form, value) {
    form._busy = value;
    for (const button of form.querySelectorAll("button")) button.disabled = value;
  }

  async function submitLine(form) {
    const values = readLineForm(form);
    if (!values) return;
    const itemId = form.dataset.editLine;
    setBusy(form, true);
    const failure = itemId
      ? await write("POST", "/item", Object.assign({ op: "edit", itemId }, values))
      : await write("POST", "/item", { op: "add", label: values.label, price: values.price });
    setBusy(form, false);
    if (failure) {
      form.querySelector(".field-msg").textContent = failure.message;
      return;
    }
    if (itemId) return closeSheet();
    editing = null;
    render();
    const button = root.querySelector("[data-add-open]");
    if (button) button.focus();
  }

  // Arms on the first tap and deletes on the second, like every delete on the
  // page, with the dish's title struck through in between.
  function armLine(form, item, doomed) {
    const current = form.querySelector("[data-delete-line]");
    const fresh = deleteLineButton(item, doomed);
    const focused = document.activeElement === current;
    current.replaceWith(fresh);
    if (focused) fresh.focus();
  }

  async function deleteLine(button) {
    const form = button.closest("form");
    const item = state.items.find((i) => i.id === button.dataset.deleteLine);
    if (!item) return;
    const key = "line:" + item.id;
    if (!armed.has(key)) {
      armed.add(key);
      armLine(form, item, true);
      render();
      setTimeout(() => {
        if (!armed.delete(key)) return;
        if (form.isConnected) armLine(form, item, false);
        render();
      }, ARM_MS);
      return;
    }
    armed.delete(key);
    setBusy(form, true);
    const failure = await write("POST", "/item", { op: "delete", itemId: button.dataset.deleteLine });
    setBusy(form, false);
    if (failure) form.querySelector(".field-msg").textContent = failure.message;
    else closeSheet();
  }

  function startEdit(field) {
    editing = { kind: "field", field };
    tipMode = "dollars";
    render();
    const input = root.querySelector('form[data-field="' + field + '"] input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  function stopEdit() {
    const field = editing && editing.kind === "field" ? editing.field : null;
    editing = null;
    render();
    const button = field && root.querySelector('[data-edit-field="' + field + '"]');
    if (button) button.focus();
  }

  function setTipMode(mode) {
    if (tipMode === mode) return;
    tipMode = mode;
    render();
    const input = root.querySelector('form[data-field="tip"] input');
    if (input) input.focus();
  }

  async function saveField(form) {
    const name = form.dataset.field;
    const msg = form.querySelector(".field-msg");
    const raw = form.elements.value.value.trim();
    const fail = (text) => {
      msg._error = true;
      msg.classList.remove("is-hint");
      msg.textContent = text;
    };
    let body;
    if (name === "printedTotal" && raw === "") {
      body = { printedTotal: null };
    } else if (name === "discount" && raw === "") {
      body = { discount: "0" };
    } else if (name === "tip" && tipMode === "percent") {
      const percent = decimal(raw.replace(/%\s*$/, ""));
      if (percent === null || hundredths(percent) > 10000) return fail("Enter a percentage like 18 or 18.5.");
      body = { tipPercent: percent };
    } else {
      // The unit already says money off, so a typed minus means the same.
      const value = decimal(name === "discount" ? raw.replace(/^[-−]\s*/, "") : raw);
      if (value === null) return fail("Enter an amount like 12.50.");
      body = {};
      body[name] = value;
    }
    setBusy(form, true);
    const failure = await write("PATCH", "", body);
    setBusy(form, false);
    if (failure) return fail(failure.message);
    stopEdit();
  }

  function guestIds() {
    return new Set(state.participants.filter((p) => p.kind === "guest").map((p) => p.id));
  }

  // A new guest goes straight into claiming: the footer turns to them and
  // every line tapped is theirs until someone else there is picked.
  async function addGuest(form) {
    const msg = form.querySelector(".field-msg");
    const name = form.elements.name.value.trim();
    if (name === "") return form.elements.name.focus();
    const before = guestIds();
    msg.textContent = "";
    setBusy(form, true);
    const failure = await write("POST", "/guest", { name });
    setBusy(form, false);
    if (failure) {
      msg.textContent = failure.message;
      form.elements.name.focus();
      return;
    }
    addingGuest = false;
    const added = state.participants.find((p) => p.kind === "guest" && !before.has(p.id) && p.addedBy === state.viewer);
    if (added) claimFor = added.id;
    render();
    focusLines();
  }

  function focusLines() {
    const list = root.querySelector("[data-items] > ul.items");
    if (!list) return;
    list.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    const first = list.querySelector("[data-claim]");
    if (first) first.focus({ preventScroll: true });
  }

  async function renameGuest(form) {
    const msg = form.querySelector(".field-msg");
    const name = form.elements.name.value.trim();
    if (name === "") return form.elements.name.focus();
    setBusy(form, true);
    const failure = await write("PATCH", "/guest/" + encodeURIComponent(form.dataset.rename), { name });
    setBusy(form, false);
    if (failure) {
      msg.textContent = failure.message;
      return;
    }
    endRename(form.dataset.rename);
  }

  // The form replaces the name button, so focus goes back to it or it is lost.
  function endRename(id) {
    if (sheet) sheet.renaming = null;
    render();
    const name = root.querySelector('[data-rename-guest="' + CSS.escape(id) + '"]');
    if (name) name.focus();
  }

  // The first tap only names what would go.
  function secondTap(key) {
    if (armed.delete(key)) return true;
    armed.add(key);
    render();
    setTimeout(() => {
      if (!armed.delete(key)) return;
      render();
    }, ARM_MS);
    return false;
  }

  async function removeMember(button) {
    const id = button.dataset.removeMember;
    if (!secondTap("remove:" + id)) return;
    const failure = await write("DELETE", "/member/" + encodeURIComponent(id));
    if (failure && sheet) sheet.msg = failure.message;
    render();
  }

  async function removeGuest(button) {
    const id = button.dataset.removeGuest;
    if (!secondTap("remove:" + id)) return;
    const failure = await write("DELETE", "/guest/" + encodeURIComponent(id));
    if (failure && sheet) sheet.msg = failure.message;
    if (claimFor === id) claimFor = null;
    render();
    // The guest's block went with them, the button included.
    if (!failure) {
      const next = root.querySelector("dialog [data-add-guest]") || root.querySelector("dialog .close");
      if (next) next.focus();
    }
  }

  // True once the server took it.
  async function toggle(key, method, path, body) {
    if (busy.has(key)) return false;
    busy.add(key);
    render();
    const failure = await write(method, path, body);
    busy.delete(key);
    // A 409 already put its reason in the note at the top; anything else
    // that refused it needs saying too.
    if (failure && failure.status !== 409 && !stopped) {
      if (sheet) sheet.msg = failure.message;
      else showNote(failure.message, true);
    }
    render();
    return !failure;
  }

  async function deleteBill() {
    if (!armed.has("delete-bill")) {
      armed.add("delete-bill");
      render();
      setTimeout(() => {
        if (armed.delete("delete-bill")) render();
      }, ARM_MS);
      return;
    }
    armed.delete("delete-bill");
    const paid = state.payments.reduce((n, p) => n + p.cents, 0);
    // The answer is not a bill to draw, so the page asks for itself again
    // and the server says it is gone.
    if (!(await toggle("delete", "DELETE", "", { paid: plain(paid) }))) return;
    stopped = true;
    clearInterval(timer);
    location.reload();
  }

  async function undoPaid(button) {
    const id = button.dataset.undoPaid;
    if (!(await toggle("undo:" + id, "DELETE", "/paid/" + encodeURIComponent(id)))) return;
    showNote("Payment undone", false);
    // The row went with the payment, the button included.
    const next = root.querySelector("[data-payments] [data-undo-paid]");
    if (next) next.focus();
  }

  // Busy while the ask's answer is out, so a second tap never sends twice.
  async function doAsk(path, method, body) {
    const kind = sheet.kind;
    if (busy.has(kind)) return null;
    busy.add(kind);
    sheet.msg = "";
    render();
    const failure = await write(method, path, body);
    busy.delete(kind);
    if (failure && sheet && sheet.kind === kind && !stopped) sheet.msg = failure.message;
    render();
    return failure;
  }

  async function runAsk() {
    if (!sheet) return;
    const kind = sheet.kind;
    if (kind === "wrong") return doAsk("/reopen", "POST");
    if (kind === "split") return doAsk("/confirm", "POST", { revision: state.revision, splitUnclaimed: true });
  }

  // Paid is yes or no, so one tap records everything left. A second tap, or
  // a retry after a lost answer, finds the person paid up and changes nothing.
  async function payAll() {
    const left = leftOf(model(view()), state.viewer);
    if (busy.has("sent") || left <= 0) return;
    busy.add("sent");
    slamming = true;
    render();
    const failure = await write("POST", "/payment", { id: newId(), amount: plain(left) });
    busy.delete("sent");
    // A 409 already put its reason in the note at the top.
    if (failure && failure.status !== 409 && !stopped) showNote(failure.message, true);
    if (failure || !paidUp(model(view()), state.viewer)) {
      slamming = false;
      render();
      return;
    }
    slam(el("span", { class: "stamp" }, "付讫"));
  }

  // Each sheet hands to the next in place. Closing first would land its close
  // event on the sheet that follows.
  function confirmBill(skipVenmo) {
    const from = root.querySelector("[data-confirm]");
    if (!skipVenmo && !state.viewerVenmo) return openSheet({ kind: "nudge", form: venmoForm(true) }, from);
    if (openLines(state).length > 0) return openSheet({ kind: "split" }, from);
    closeSheet();
    return toggle("confirm", "POST", "/confirm", { revision: state.revision });
  }

  async function saveVenmo(form) {
    const msg = form.querySelector(".field-msg");
    msg.textContent = "";
    setBusy(form, true);
    const failure = await write("POST", "/venmo", { username: form.elements.username.value });
    setBusy(form, false);
    if (failure) {
      msg.textContent = failure.message;
      return;
    }
    if (form.dataset.venmoForm === "confirm") confirmBill();
    else closeSheet();
  }

  function newId() {
    return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }

  async function savePayer() {
    if (!sheet || !sheet.picked || sheet.picked === state.payerId) return;
    // Success needs no handling here: the new state says the viewer no
    // longer paid, and adopting it reloads the page without these controls.
    const failure = await write("PATCH", "", { payer: sheet.picked });
    if (failure && sheet) {
      sheet.msg = failure.message;
      render();
    }
  }

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    const dialog = target.closest("dialog[data-sheet]");
    // A tap on the backdrop lands on the dialog itself.
    if (dialog && target === dialog) return closeSheet();
    const go = target.closest("[data-go]");
    if (go) {
      pushedView = true;
      return;
    }
    if (target.closest("[data-back]")) {
      event.preventDefault();
      if (pushedView) history.back();
      else {
        history.replaceState(null, "", location.pathname + location.search);
        showView();
      }
      return;
    }
    if (target.closest("[data-close-sheet]")) return closeSheet();
    const person = target.closest("[data-person]");
    if (person) return openSheet({ kind: "person", id: person.dataset.person }, person);
    if (stopped) return;
    const claim = target.closest("[data-claim]");
    if (claim) return onClaim(claim);
    const line = target.closest("[data-open-line]");
    if (line) return openSheet({ kind: "line", id: line.dataset.openLine, form: null }, line);
    if (target.closest("[data-open-payer]")) return openSheet({ kind: "payer", picked: null }, target.closest("[data-open-payer]"));
    const pick = target.closest("[data-pick-payer]");
    if (pick && sheet) {
      sheet.picked = pick.dataset.pickPayer;
      return render();
    }
    if (target.closest("[data-save-payer]")) return savePayer();
    const ask = target.closest("[data-ask]");
    if (ask) {
      const kind = ask.dataset.ask;
      return openSheet({ kind }, ask);
    }
    if (target.closest("[data-do]")) return runAsk();
    if (target.closest("[data-delete-bill]")) return deleteBill();
    if (target.closest("[data-pay-all]")) return payAll();
    const undo = target.closest("[data-undo-paid]");
    if (undo) return undoPaid(undo);
    const confirm = target.closest("[data-confirm]");
    if (confirm) return confirm.disabled ? null : confirmBill();
    if (target.closest("[data-reopen]")) return toggle("reopen", "POST", "/reopen");
    const field = target.closest("[data-edit-field]");
    if (field) return startEdit(field.dataset.editField);
    const mode = target.closest("[data-tip-mode]");
    if (mode) return setTipMode(mode.dataset.tipMode);
    const addAddon = target.closest("[data-add-addon]");
    if (addAddon) {
      const row = addonRow({ label: "", cents: 0 });
      addAddon.before(row);
      refreshDish(addAddon.form);
      row.querySelector("input").focus();
      return;
    }
    const removeAddon = target.closest("[data-remove-addon]");
    if (removeAddon) {
      const form = removeAddon.form;
      const row = removeAddon.closest("[data-addon]");
      const next = row.nextElementSibling && row.nextElementSibling.matches("[data-addon]") ? row.nextElementSibling : null;
      row.remove();
      refreshDish(form);
      (next ? next.querySelector("[data-remove-addon]") : form.querySelector("[data-add-addon]")).focus();
      return;
    }
    const del = target.closest("[data-delete-line]");
    if (del) return deleteLine(del);
    if (target.closest("[data-add-open]")) {
      editing = { kind: "line" };
      return render();
    }
    if (target.closest("[data-add-guest]")) {
      closeSheet();
      addingGuest = true;
      render();
      const input = root.querySelector("form[data-guest-form] input");
      if (input) input.focus();
      return;
    }
    const as = target.closest("[data-claim-as]");
    if (as) {
      claimFor = as.dataset.claimAs === state.viewer ? null : as.dataset.claimAs;
      return render();
    }
    const rename = target.closest("[data-rename-guest]");
    if (rename && sheet) {
      sheet.renaming = rename.dataset.renameGuest;
      render();
      const input = root.querySelector("form[data-rename] input");
      if (input) input.select();
      return;
    }
    const remove = target.closest("[data-remove-guest]");
    if (remove) return removeGuest(remove);
    const removing = target.closest("[data-remove-member]");
    if (removing) return removeMember(removing);
    const venmo = target.closest("[data-venmo]");
    if (venmo) return openSheet({ kind: "venmo", form: venmoForm(false) }, venmo);
    if (target.closest("[data-confirm-anyway]")) return confirmBill(true);
    const forgive = target.closest("[data-forgive]");
    if (forgive) {
      if (forgive.disabled) return;
      const id = forgive.dataset.forgive;
      return toggle("forgive:" + id, "POST", "/pardon", { participantId: id, pardoned: forgive.dataset.pardoned !== "true" });
    }
    const paid = target.closest("[data-guest-paid]");
    if (paid) {
      const id = paid.dataset.guestPaid;
      return toggle("paid:" + id, "POST", "/guest/" + encodeURIComponent(id) + "/paid", { paid: paid.getAttribute("aria-pressed") !== "true" });
    }
    const cancel = target.closest("[data-cancel]");
    if (cancel) {
      const form = cancel.closest("form");
      if (!form) return;
      if (form.dataset.field) return stopEdit();
      if (form.dataset.addLine !== undefined) {
        editing = null;
        render();
        const button = root.querySelector("[data-add-open]");
        if (button) button.focus();
        return;
      }
      if (form.dataset.guestForm !== undefined) {
        addingGuest = false;
        render();
        const button = root.querySelector("[data-add-guest]");
        if (button) button.focus();
        return;
      }
      if (form.dataset.rename && sheet) endRename(form.dataset.rename);
    }
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    event.preventDefault();
    if (stopped || form._busy) return;
    if (form.dataset.field) saveField(form);
    else if (form.dataset.editLine || form.dataset.addLine !== undefined) submitLine(form);
    else if (form.dataset.guestForm !== undefined) addGuest(form);
    else if (form.dataset.rename) renameGuest(form);
    else if (form.dataset.venmoForm !== undefined) saveVenmo(form);
  });

  root.addEventListener("input", (event) => {
    const form = event.target instanceof Element ? event.target.closest("form") : null;
    if (!form) return;
    const msg = form.querySelector(".field-msg");
    if (msg) {
      msg._error = false;
      msg.textContent = "";
    }
    if (form.dataset.field === "tip") tipPreview(view());
    if (form.classList.contains("dish-form")) refreshDish(form);
  });

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const form = event.target instanceof Element ? event.target.closest("form") : null;
    if (!form || form.closest("dialog")) return;
    const cancel = form.querySelector("[data-cancel]");
    if (cancel) cancel.click();
  });

  window.addEventListener("hashchange", showView);

  // Polling keeps a shared page honest about other people's claims. A hidden
  // tab skips its turn and catches up the moment it is shown again.
  const timer = setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });

  showView();
  render();
  root.classList.add("is-live");
  greet();
})();
`;
