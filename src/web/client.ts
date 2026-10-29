// Shipped inline as plain browser JavaScript with no build step, so it is a
// string here rather than a module the Worker imports and runs. String.raw
// keeps its regex backslashes intact, which means the script itself may use
// no template literals. It must never contain a closing script tag, since it
// is pasted between script tags.
//
// The words it renders mirror page.ts, which draws the same state on first
// load; a copy change in one needs the same change in the other.
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
  const ROW_ERROR_MS = 4000;
  const MAX_LABEL = 120;
  const STATUS_LABEL = {
    reading: "Reading the receipt",
    draft: "Draft · amounts change as people claim",
    confirmed: "Confirmed · amounts are locked",
    superseded: "Replaced by a newer split",
    deleted: "Deleted",
  };

  // Claims tapped but not yet answered. They are drawn over whatever state the
  // server last sent, so a poll or another write landing first never flips a
  // chip back under the finger that just tapped it.
  const pending = [];
  const rowErrors = new Map();
  let queue = Promise.resolve();
  let writes = 0;
  let polling = false;
  let stopped = false;
  let tipMode = "dollars";
  // Forgive toggles whose answer has not come back, held off a second tap.
  const forgiving = new Set();

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

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const name in attrs || {}) {
      const value = attrs[name];
      if (value === false || value === null || value === undefined) continue;
      if (name === "class") node.className = value;
      else node.setAttribute(name, value === true ? "" : String(value));
    }
    for (const child of [].concat(children === undefined ? [] : children)) {
      if (child !== null && child !== false && child !== undefined) node.append(child);
    }
    return node;
  }

  function namesOf(s) {
    return new Map(s.participants.map((p) => [p.id, p.displayName]));
  }

  function and(parts) {
    return parts.length <= 1 ? parts.join("") : parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  }

  // Mirrors debtorOf on the server: a guest's share is asked of whoever
  // brought them.
  function debtorOf(p) {
    return p.kind === "guest" && p.addedBy ? p.addedBy : p.id;
  }

  // The viewer's own share and their guests', in roster order, or null.
  function youGroup(s) {
    const own = s.result.shares.find((x) => x.participant === s.viewer);
    if (!own) return null;
    const guests = s.participants
      .filter((p) => p.kind === "guest" && p.addedBy === s.viewer)
      .map((p) => s.result.shares.find((x) => x.participant === p.id))
      .filter(Boolean);
    const owed = [own].concat(guests).reduce((n, x) => n + (x.pardoned ? 0 : x.owedCents), 0);
    return { own, guests, owed };
  }

  function youExtra(s, group, names) {
    const payer = names.get(s.payerId) || "the person who paid";
    const name = (x) => names.get(x.participant) || "your guest";
    const owing = group.guests.filter((g) => !g.pardoned).map((g) => name(g) + "'s " + money(g.owedCents));
    const forgiven = (group.own.pardoned ? ["your " + money(group.own.owedCents)] : [])
      .concat(group.guests.filter((g) => g.pardoned).map((g) => name(g) + "'s " + money(g.owedCents)));
    return [owing.length > 0 ? "Includes " + and(owing) + "." : "", forgiven.length > 0 ? payer + " forgave " + and(forgiven) + "." : ""]
      .filter(Boolean)
      .join(" ");
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
  }

  // Swaps in a freshly built node only when what it shows has changed, so a
  // poll that brings nothing new touches nothing, and keeps keyboard focus on
  // the same control when it does swap.
  function keyed(parent, selector, key, build, before) {
    const old = parent.querySelector(":scope > " + selector);
    if (old && old._key === key) return old;
    const fresh = build();
    fresh._key = key;
    const focused = old && old.contains(document.activeElement) ? document.activeElement : null;
    if (old) old.replaceWith(fresh);
    else parent.insertBefore(fresh, before || null);
    if (focused) {
      const twin = focused.dataset.participant
        ? Array.from(fresh.querySelectorAll("button")).find((b) => b.dataset.participant === focused.dataset.participant)
        : fresh.matches("button") ? fresh : null;
      if (twin) twin.focus();
    }
    return fresh;
  }

  function renderYou(s) {
    const card = root.querySelector("[data-you]");
    if (!card) return;
    const names = namesOf(s);
    const group = youGroup(s);
    const key = JSON.stringify([group, s.status, s.viewerIsPayer, s.payerCollectsCents, Array.from(names)]);
    if (card._key === key) return;
    card._key = key;

    const draft = s.status === "draft";
    const soFar = draft ? " so far" : "";
    const payer = names.get(s.payerId) || "the person who paid";
    let label;
    let note;
    if (!group) {
      label = "You're not on this bill";
      note = draft
        ? ["If you were at dinner, tap ", el("strong", null, "Open the split"), " on the bill in Discord to join it."]
        : "Nothing here is yours to pay.";
    } else if (s.viewerIsPayer) {
      label = "Your share" + soFar;
      note = ["You paid, so the others owe you ", el("strong", { class: "money" }, money(s.payerCollectsCents)), soFar + "."];
    } else {
      label = draft ? "Your share so far" : "You owe " + payer;
      const forgiven = [group.own].concat(group.guests).some((x) => x.pardoned);
      note = draft
        ? "You'll pay this to " + payer + " once the bill is confirmed."
        : group.owed === 0 && forgiven
          ? payer + " covered your share, so there's nothing to pay."
          : "Pay " + payer + " from the bill message in Discord.";
    }
    const counted = group ? [group.own].concat(group.guests).filter((x) => !x.pardoned) : [];
    const sum = (pick) => money(counted.reduce((n, x) => n + pick(x), 0));
    const extra = group ? youExtra(s, group, names) : "";
    card.replaceChildren(
      el("h2", { class: "you-label", id: "you-label" }, label),
      el("p", { class: "you-amount money", "data-you-owed": true }, money(group ? group.owed : 0)),
      counted.length > 0
        ? el("p", { class: "you-detail", "data-you-detail": true }, [
            "Food ", el("span", { class: "money" }, sum((x) => x.subtotalCents)),
            " · Tax ", el("span", { class: "money" }, sum((x) => x.taxCents)),
            " · Tip ", el("span", { class: "money" }, sum((x) => x.tipCents)),
          ])
        : "",
      extra ? el("p", { class: "you-detail", "data-you-extra": true }, extra) : "",
      el("p", { class: "you-note" }, note),
    );
  }

  function reconcileText(s) {
    const total = s.printedTotalCents;
    const gap = s.reconciles.discrepancyCents;
    if (s.reconciles.ok && total !== null) return "Adds up: the items and tax match the printed total of " + money(total) + ".";
    if (total === null || gap === null) {
      return "Enter the printed total from the receipt to check this read. Confirm appears in Discord once it adds up.";
    }
    return "Doesn't add up yet: the items and tax come to " + money(total + gap) + ", " + money(Math.abs(gap)) + " " +
      (gap > 0 ? "more" : "less") + " than the printed total of " + money(total) + ".";
  }

  function fieldForm(name) {
    return root.querySelector('form[data-field="' + name + '"]');
  }

  // An input someone has typed into keeps what they typed; only a clean one
  // follows the server.
  function syncInput(input, shown) {
    if (input._shown === undefined) input._shown = input.defaultValue;
    if (input.value === input._shown && input.value !== shown) input.value = shown;
    input._shown = shown;
  }

  function isDirty(form) {
    const input = form.elements.value;
    return input.value !== (input._shown === undefined ? input.defaultValue : input._shown);
  }

  function tipPreview(s) {
    const form = fieldForm("tip");
    if (!form) return;
    const note = form.querySelector("[data-note]");
    if (note._message) return;
    if (tipMode !== "percent") {
      note.textContent = "";
      return;
    }
    const subtotal = Math.max(0, s.result.billSubtotalCents);
    const typed = decimal(form.elements.value.value.replace(/%\s*$/, ""));
    const points = typed === null ? null : hundredths(typed);
    if (points === null || points > 10000) {
      note.textContent = "A percentage of the " + money(subtotal) + " food subtotal, before tax.";
      return;
    }
    const n = subtotal * points + 5000;
    note.textContent = "= " + money((n - (n % 10000)) / 10000) + " on the " + money(subtotal) + " food subtotal, before tax.";
  }

  function renderCheck(s) {
    const card = root.querySelector("[data-check]");
    if (!card) return;
    card.hidden = !(s.viewerIsPayer && s.status === "draft" && !stopped);
    if (card.hidden) return;
    const banner = card.querySelector("[data-reconcile]");
    banner.className = "check-status " + (s.reconciles.ok ? "is-ok" : "is-off");
    banner.textContent = reconcileText(s);

    const fields = { printedTotal: s.printedTotalCents, tax: s.taxCents, tip: s.tipCents };
    for (const name in fields) {
      const form = fieldForm(name);
      if (!form) continue;
      if (!(name === "tip" && tipMode === "percent")) syncInput(form.elements.value, fields[name] === null ? "" : plain(fields[name]));
      form.querySelector("button[type=submit]").disabled = form._busy || !isDirty(form);
    }
    tipPreview(s);
    renderPayer(s);
  }

  // Like the money inputs, a pick not yet saved stays put while polls arrive;
  // an untouched picker follows whoever the server says paid.
  function renderPayer(s) {
    const form = root.querySelector("form[data-payer-form]");
    if (!form) return;
    form.hidden = s.hasPayments;
    if (form.hidden) return;
    const select = form.elements.payer;
    const members = s.participants.filter((p) => p.kind === "member");
    const key = JSON.stringify(members.map((p) => [p.id, p.displayName]));
    const picked = select.value;
    const clean = select._shown === undefined || picked === select._shown;
    if (select._key !== undefined && select._key !== key) {
      select.replaceChildren.apply(select, members.map((p) => el("option", { value: p.id }, p.displayName)));
    }
    select._key = key;
    select.value = clean ? s.payerId : picked;
    if (select.value === "") select.value = s.payerId;
    select._shown = s.payerId;
    form.querySelector("button[type=submit]").disabled = form._busy || select.value === s.payerId;
  }

  function chipOrder(s) {
    const me = s.participants.filter((p) => p.id === s.viewer);
    return me.concat(s.participants.filter((p) => p.id !== s.viewer));
  }

  function hint(s) {
    if (stopped) return ["This page has stopped updating. Tap ", el("strong", null, "Open the split"), " in Discord for a fresh link."];
    switch (s.editable) {
      case "all":
        return "You paid, so you can tap anyone onto a line, and tap a line's name or price to fix it. Tap several people on one line to split it evenly.";
      case "self":
        return ["Tap ", el("strong", null, "You"), " on every line you had. On a shared dish, everyone tapped on it splits it evenly."];
      default:
        if (s.status === "draft") return "You're not on this bill, so there's nothing here for you to tap.";
        if (s.status === "confirmed") return "This bill is confirmed, so these amounts are locked.";
        return "This bill can't be changed any more.";
    }
  }

  function metaNode(s, item, names) {
    const error = rowErrors.get(item.id);
    if (error) return el("p", { class: "item-meta is-error", role: "alert" }, error);
    const n = item.claimedBy.length;
    if (n === 0) return el("p", { class: "item-meta item-flag" }, "Nobody has claimed this yet");
    if (n > 1) return el("p", { class: "item-meta" }, "Split " + n + " ways");
    const only = item.claimedBy[0];
    return el("p", { class: "item-meta" }, "Just " + (only === s.viewer ? "you" : names.get(only) || only));
  }

  function chipNode(s, item, p, mode) {
    const isViewer = p.id === s.viewer;
    const canTap = mode === "all" || (mode === "self" && isViewer);
    return el("button", {
      type: "button",
      class: "chip" + (isViewer ? " is-viewer" : ""),
      "data-item": item.id,
      "data-participant": p.id,
      "aria-pressed": String(item.claimedBy.includes(p.id)),
      disabled: !canTap,
    }, isViewer ? "You" : p.displayName);
  }

  function patchRow(li, s, item, people, names) {
    const mode = editable(s);
    const payerEdits = mode === "all";
    li.classList.toggle("is-unclaimed", item.claimedBy.length === 0);
    const editor = li.querySelector(":scope > [data-editor]");
    if (editor && !payerEdits) editor.remove();

    keyed(li, ".item-line", JSON.stringify([item.label, item.cents, payerEdits]), () => {
      const kids = [el("span", { class: "item-label" }, item.label), el("span", { class: "item-price" }, money(item.cents))];
      if (!payerEdits) return el("div", { class: "item-line" }, kids);
      return el("button", {
        type: "button",
        class: "item-line",
        "data-edit-item": true,
        "aria-expanded": String(Boolean(li.querySelector(":scope > [data-editor]"))),
        "aria-label": "Fix " + item.label + ", " + money(item.cents),
      }, kids);
    }, li.firstChild);

    const claimed = item.claimedBy.slice().sort();
    const single = claimed.length === 1 ? names.get(claimed[0]) : null;
    keyed(li, ".item-meta", JSON.stringify([claimed, single, s.viewer, rowErrors.get(item.id) || null]),
      () => metaNode(s, item, names), li.querySelector(":scope > .chips") || li.querySelector(":scope > [data-editor]"));

    const roster = people.map((p) => [p.id, p.displayName]);
    keyed(li, ".chips", JSON.stringify([roster, claimed, mode, s.viewer, item.label]), () =>
      el("div", { class: "chips", role: "group", "aria-label": "Who had " + item.label },
        people.map((p) => chipNode(s, item, p, mode))),
    li.querySelector(":scope > [data-editor]"));
  }

  function renderItems(s) {
    const section = root.querySelector("[data-items]");
    if (!section) return;
    const names = namesOf(s);
    const mode = editable(s);

    const open = s.items.filter((i) => i.claimedBy.length === 0).length;
    const head = section.querySelector(".section-head");
    let badge = head.querySelector("[data-unclaimed-badge]");
    if (open > 0) {
      if (!badge) {
        badge = el("span", { class: "badge", "data-unclaimed-badge": true });
        head.append(badge);
      }
      badge.textContent = open + " unclaimed";
    } else if (badge) {
      badge.remove();
    }

    const hintNode = section.querySelector("[data-hint]");
    const hintKey = JSON.stringify([mode, s.status, stopped]);
    if (hintNode._key !== hintKey) {
      hintNode._key = hintKey;
      hintNode.replaceChildren.apply(hintNode, [].concat(hint(s)));
    }

    const add = section.querySelector("[data-add-line]");
    let list = section.querySelector("ul.items");
    let empty = section.querySelector("p.empty");
    if (s.items.length === 0) {
      if (list) list.remove();
      if (!empty) section.insertBefore(el("p", { class: "empty" }, "No items on this bill."), add);
    } else {
      if (empty) empty.remove();
      if (!list) {
        list = el("ul", { class: "items" });
        section.insertBefore(list, add);
      }
      const people = chipOrder(s);
      const rows = new Map();
      for (const li of list.querySelectorAll(":scope > li.item")) rows.set(li.dataset.item, li);
      let previous = null;
      for (const item of s.items) {
        let li = rows.get(item.id);
        if (li) rows.delete(item.id);
        else li = el("li", { class: "item", "data-item": item.id });
        patchRow(li, s, item, people, names);
        const slot = previous ? previous.nextElementSibling : list.firstElementChild;
        if (slot !== li) list.insertBefore(li, slot);
        previous = li;
      }
      for (const gone of rows.values()) gone.remove();
    }

    if (add) {
      add.hidden = mode !== "all";
      if (add.hidden) closeAdd();
    }
  }

  function forgiveSlot(s, p, share, paid) {
    if (!share || debtorOf(p) === s.payerId) return el("span", { class: "forgive-slot" });
    return el("span", { class: "forgive-slot" }, el("button", {
      type: "button",
      class: "btn forgive",
      "data-forgive": p.id,
      "aria-pressed": String(share.pardoned),
      "aria-label": "Forgive " + p.displayName + "'s share",
      // Busy rather than disabled while its answer is out, so the button
      // keeps keyboard focus across the redraw.
      "aria-busy": forgiving.has(p.id) ? "true" : null,
      disabled: paid.has(debtorOf(p)) || stopped,
    }, "Forgive"));
  }

  function renderPeople(s) {
    const list = root.querySelector("ul.people");
    if (!list) return;
    const heading = root.querySelector("[data-people-heading]");
    if (heading) heading.textContent = s.status === "draft" ? "Everyone so far" : "Everyone";
    const forgive = s.viewerIsPayer && s.status === "confirmed";
    const key = JSON.stringify([s.participants, s.result.shares, s.viewer, s.payerId, forgive, s.paid, stopped, Array.from(forgiving)]);
    if (list._key === key) return;
    list._key = key;
    const names = namesOf(s);
    const shares = new Map(s.result.shares.map((x) => [x.participant, x]));
    const paid = new Set(s.paid);
    const blocked = s.participants.some((p) => shares.has(p.id) && debtorOf(p) !== s.payerId && paid.has(debtorOf(p)));
    const note = root.querySelector("[data-forgive-note]");
    if (note) {
      note.hidden = !forgive;
      note.textContent = forgive
        ? "Forgive a share and you cover it yourself; nobody else's amount changes." +
          (blocked ? " Someone who has paid can't be forgiven until their payments are undone in Discord." : "")
        : "";
    }
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset.forgive : undefined;
    list.classList.toggle("has-forgive", forgive);
    list.replaceChildren.apply(list, s.participants.map((p) => {
      const share = shares.get(p.id);
      const tags = [];
      if (p.id === s.viewer) tags.push("you");
      if (p.id === s.payerId) tags.push("paid");
      if (p.kind === "guest") {
        const host = p.addedBy ? names.get(p.addedBy) : undefined;
        tags.push(host ? "guest of " + host : "guest");
      }
      if (share && share.pardoned) tags.push("forgiven");
      return el("li", { class: "person" + (p.id === s.viewer ? " is-viewer" : "") }, [
        el("span", { class: "person-name" }, [p.displayName].concat(tags.map((t) => el("span", { class: "tag" }, t)))),
        el("span", { class: "money" + (share && share.pardoned ? " is-forgiven" : ""), "data-share": p.id }, money(share ? share.owedCents : 0)),
        forgive ? forgiveSlot(s, p, share, paid) : null,
      ]);
    }));
    if (focused) {
      const twin = Array.from(list.querySelectorAll("[data-forgive]")).find((b) => b.dataset.forgive === focused);
      if (twin && !twin.disabled) twin.focus();
    }
  }

  // Like the payer picker, the options follow the roster but a pick or a name
  // being typed is never taken away by a poll.
  function renderGuestForm(s) {
    const form = root.querySelector("form[data-guest-form]");
    if (!form) return;
    form.hidden = !(s.viewerIsPayer && s.status === "draft" && !stopped);
    if (form.hidden) return;
    const select = form.elements.with;
    const members = s.participants.filter((p) => p.kind === "member");
    const key = JSON.stringify(members.map((p) => [p.id, p.displayName]));
    if (select._key !== undefined && select._key !== key) {
      const picked = select.value;
      select.replaceChildren.apply(select, [el("option", { value: "", disabled: true }, "Pick someone")]
        .concat(members.map((p) => el("option", { value: p.id }, p.displayName))));
      select.value = members.some((p) => p.id === picked) ? picked : "";
    }
    select._key = key;
    guestReady(form);
  }

  function guestReady(form) {
    form.querySelector("button[type=submit]").disabled = form._busy || form.elements.name.value.trim() === "" || form.elements.with.value === "";
  }

  function renderTotals(s) {
    const totals = root.querySelector("dl.totals");
    if (!totals) return;
    const values = {
      subtotal: s.result.billSubtotalCents,
      tax: s.taxCents,
      tip: s.tipCents,
      total: s.result.distributableCents,
    };
    for (const name in values) {
      const cell = totals.querySelector('[data-total="' + name + '"]');
      if (cell) cell.textContent = money(values[name]);
    }
    let short = totals.querySelector('[data-total="unclaimed"]');
    if (s.result.unclaimedCents === 0) {
      if (short) short.parentElement.remove();
      return;
    }
    if (!short) {
      short = el("dd", { "data-total": "unclaimed" });
      totals.append(el("div", { class: "row short" }, [el("dt", null, "Not claimed yet"), short]));
    }
    short.textContent = money(s.result.unclaimedCents);
  }

  function render() {
    const s = view();
    root.dataset.status = s.status;
    root.dataset.editable = editable(s);
    root.dataset.revision = String(s.revision);
    root.dataset.viewerIsPayer = String(s.viewerIsPayer);
    const label = root.querySelector("[data-status-label]");
    if (label) label.textContent = STATUS_LABEL[s.status] || s.status;
    renderYou(s);
    renderCheck(s);
    renderItems(s);
    renderPeople(s);
    renderGuestForm(s);
    renderTotals(s);
  }

  function adopt(next) {
    if (!next || typeof next.revision !== "number" || next.revision < state.revision) return;
    // A change in who may edit what gets a fresh page rather than a redraw:
    // the server draws the payer's controls only for the payer, so someone
    // just handed the bill would otherwise have nothing to fix it with.
    if (next.viewerIsPayer !== state.viewerIsPayer || next.editable !== state.editable) {
      stopped = true;
      clearInterval(timer);
      location.reload();
      return;
    }
    const was = state.status;
    state = next;
    if (was !== next.status) {
      if (next.status === "draft") showNote("The bill was reopened, so it can be changed again.", false);
      else if (next.status === "confirmed") showNote("The bill was just confirmed, so it's locked. These are the final amounts.", false);
    }
    render();
  }

  function stop(message) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const editor of root.querySelectorAll("[data-editor]")) editor.remove();
    closeAdd();
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

  // Writes go one at a time, in tap order: two quick taps on one chip must
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

  function flashRowError(itemId, text) {
    rowErrors.set(itemId, text);
    setTimeout(() => {
      if (rowErrors.get(itemId) !== text) return;
      rowErrors.delete(itemId);
      render();
    }, ROW_ERROR_MS);
  }

  function onChipTap(chip) {
    if (stopped) return;
    const op = {
      itemId: chip.dataset.item,
      participantId: chip.dataset.participant,
      claimed: chip.getAttribute("aria-pressed") !== "true",
    };
    pending.push(op);
    rowErrors.delete(op.itemId);
    render();
    write("POST", "/claim", op).then((failure) => {
      pending.splice(pending.indexOf(op), 1);
      if (failure && !stopped) {
        flashRowError(op.itemId, failure.status === 0 ? "Couldn't reach AAzhi. Tap again." : "That didn't save. Tap again.");
      }
      render();
    });
  }

  let formIds = 0;

  function itemForm(kind, item) {
    const n = ++formIds;
    const off = item ? item.cents < 0 : false;
    const form = el("form", { class: "editor", novalidate: true }, [
      el("div", { class: "editor-row" }, [
        el("label", { for: "line-name-" + n }, "Name"),
        el("input", { id: "line-name-" + n, class: "text-input", name: "label", maxlength: MAX_LABEL, autocomplete: "off", enterkeyhint: "next" }),
      ]),
      el("div", { class: "editor-row" }, [
        el("label", { for: "line-price-" + n }, "Price"),
        el("div", { class: "money-input" }, [
          el("span", { "aria-hidden": "true" }, "$"),
          el("input", { id: "line-price-" + n, name: "price", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done" }),
        ]),
      ]),
      el("label", { class: "editor-check" }, [el("input", { type: "checkbox", name: "off" }), "Money off (a discount or comp)"]),
      el("p", { class: "editor-msg", role: "status" }),
      el("div", { class: "editor-actions" }, [
        el("button", { type: "submit", class: "btn primary" }, kind === "edit" ? "Save" : "Add line"),
        el("button", { type: "button", class: "btn", "data-cancel": true }, "Cancel"),
        kind === "edit" ? el("button", { type: "button", class: "btn danger", "data-delete": true }, "Delete line") : null,
      ]),
    ]);
    if (item) {
      form.elements.label.value = item.label;
      form.elements.price.value = plain(Math.abs(item.cents));
      form.elements.off.checked = off;
    }
    return form;
  }

  function readItemForm(form) {
    const msg = form.querySelector(".editor-msg");
    const label = form.elements.label.value.trim();
    if (label.length === 0 || label.length > MAX_LABEL) {
      msg.textContent = "Give the line a name.";
      form.elements.label.focus();
      return null;
    }
    const price = decimal(form.elements.price.value);
    if (price === null) {
      msg.textContent = "Enter the price like 12.50.";
      form.elements.price.focus();
      return null;
    }
    return { label, price: form.elements.off.checked && hundredths(price) !== 0 ? "-" + price : price };
  }

  function setFormBusy(form, busy) {
    form._busy = busy;
    for (const button of form.querySelectorAll("button")) button.disabled = busy;
  }

  function toggleEditor(li) {
    const open = li.querySelector(":scope > [data-editor]");
    const line = li.querySelector(":scope > [data-edit-item]");
    if (open) {
      open.remove();
      if (line) line.setAttribute("aria-expanded", "false");
      return;
    }
    for (const other of root.querySelectorAll("[data-editor]")) {
      const owner = other.closest("li.item");
      other.remove();
      const button = owner && owner.querySelector(":scope > [data-edit-item]");
      if (button) button.setAttribute("aria-expanded", "false");
    }
    const item = state.items.find((i) => i.id === li.dataset.item);
    if (!item) return;
    const form = itemForm("edit", item);
    form.dataset.editor = item.id;
    li.append(form);
    if (line) line.setAttribute("aria-expanded", "true");
    form.elements.price.focus();
    form.elements.price.select();
  }

  async function saveItem(form) {
    const values = readItemForm(form);
    if (!values) return;
    const itemId = form.dataset.editor;
    setFormBusy(form, true);
    const failure = await write("POST", "/item", { op: "edit", itemId, label: values.label, price: values.price });
    setFormBusy(form, false);
    if (failure) {
      form.querySelector(".editor-msg").textContent = failure.message;
      return;
    }
    const li = form.closest("li.item");
    form.remove();
    const line = li && li.querySelector(":scope > [data-edit-item]");
    if (line) {
      line.setAttribute("aria-expanded", "false");
      line.focus();
    }
  }

  async function deleteItem(button) {
    const form = button.closest("form");
    // A second tap confirms, so one stray tap never drops a line.
    if (!button._armed) {
      button._armed = true;
      button.textContent = "Tap again to delete";
      setTimeout(() => {
        button._armed = false;
        button.textContent = "Delete line";
      }, ROW_ERROR_MS);
      return;
    }
    setFormBusy(form, true);
    const failure = await write("POST", "/item", { op: "delete", itemId: form.dataset.editor });
    setFormBusy(form, false);
    if (failure) form.querySelector(".editor-msg").textContent = failure.message;
  }

  function closeAdd() {
    const add = root.querySelector("[data-add-line]");
    if (!add || !add.classList.contains("is-open")) return;
    add.classList.remove("is-open");
    add.replaceChildren(el("button", { type: "button", class: "btn btn-add", "data-add-open": true }, "Add a missing line"));
  }

  function openAdd() {
    const add = root.querySelector("[data-add-line]");
    if (!add) return;
    const form = itemForm("add", null);
    form.dataset.adder = "";
    add.classList.add("is-open");
    add.replaceChildren(form);
    form.elements.label.focus();
  }

  async function addItem(form) {
    const values = readItemForm(form);
    if (!values) return;
    setFormBusy(form, true);
    const failure = await write("POST", "/item", { op: "add", label: values.label, price: values.price });
    setFormBusy(form, false);
    if (failure) {
      form.querySelector(".editor-msg").textContent = failure.message;
      return;
    }
    closeAdd();
    const button = root.querySelector("[data-add-open]");
    if (button) button.focus();
  }

  function setTipMode(mode) {
    const form = fieldForm("tip");
    if (!form || tipMode === mode) return;
    tipMode = mode;
    for (const button of form.querySelectorAll("[data-tip-mode]")) {
      button.setAttribute("aria-pressed", String(button.dataset.tipMode === mode));
    }
    const input = form.elements.value;
    form.querySelector(".money-input").classList.toggle("is-percent", mode === "percent");
    form.querySelector("[data-unit]").textContent = mode === "percent" ? "%" : "$";
    input.placeholder = mode === "percent" ? "e.g. 20" : "";
    input.value = mode === "percent" ? "" : plain(state.tipCents);
    input._shown = input.value;
    render();
    if (mode === "percent") input.focus();
  }

  function say(form, text, isError) {
    const note = form.querySelector("[data-note]");
    note._message = text;
    note.textContent = text;
    note.style.color = isError ? "var(--warn)" : "";
    clearTimeout(note._timer);
    if (!isError) {
      note._timer = setTimeout(() => {
        note._message = null;
        note.textContent = "";
        render();
      }, 2000);
    }
  }

  async function saveField(form) {
    const name = form.dataset.field;
    const input = form.elements.value;
    const raw = input.value.trim();
    let body;
    if (name === "printedTotal" && raw === "") {
      body = { printedTotal: null };
    } else if (name === "tip" && tipMode === "percent") {
      const percent = decimal(raw.replace(/%\s*$/, ""));
      if (percent === null || hundredths(percent) > 10000) return say(form, "Enter a percentage like 18 or 18.5.", true);
      body = { tipPercent: percent };
    } else {
      const amount = decimal(raw);
      if (amount === null) return say(form, "Enter an amount like 12.50.", true);
      body = {};
      body[name] = amount;
    }
    setFormBusy(form, true);
    const failure = await write("PATCH", "", body);
    setFormBusy(form, false);
    if (failure) {
      say(form, failure.message, true);
      render();
      return;
    }
    // Clean again, so the next render shows the amount the server stored.
    input._shown = input.value;
    if (name === "tip") setTipMode("dollars");
    say(form, "Saved", false);
    render();
  }

  // Success needs no handling here: the new state says the viewer no longer
  // paid, and adopting it reloads the page without the payer's controls.
  async function savePayer(form) {
    const select = form.elements.payer;
    if (select.value === state.payerId) return;
    setFormBusy(form, true);
    const failure = await write("PATCH", "", { payer: select.value });
    setFormBusy(form, false);
    if (failure) {
      say(form, failure.message, true);
      render();
    }
  }

  async function addGuest(form) {
    const msg = form.querySelector(".editor-msg");
    const name = form.elements.name.value.trim();
    if (name === "" || form.elements.with.value === "") return;
    msg.textContent = "";
    setFormBusy(form, true);
    const failure = await write("POST", "/guest", { name, with: form.elements.with.value });
    setFormBusy(form, false);
    if (failure) {
      msg.textContent = failure.message;
      guestReady(form);
      return;
    }
    form.elements.name.value = "";
    form.elements.with.value = "";
    guestReady(form);
    form.elements.name.focus();
  }

  async function toggleForgive(button) {
    const participantId = button.dataset.forgive;
    if (forgiving.has(participantId)) return;
    forgiving.add(participantId);
    render();
    const failure = await write("POST", "/pardon", { participantId, pardoned: button.getAttribute("aria-pressed") !== "true" });
    forgiving.delete(participantId);
    // A 409 already put its reason in the note at the top; anything else
    // that refused it needs saying too.
    if (failure && failure.status !== 409 && !stopped) showNote(failure.message, true);
    render();
  }

  root.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target || !root.contains(target)) return;
    const chip = target.closest("button.chip");
    if (chip) {
      if (!chip.disabled) onChipTap(chip);
      return;
    }
    if (stopped) return;
    const line = target.closest("[data-edit-item]");
    if (line) return toggleEditor(line.closest("li.item"));
    const cancel = target.closest("[data-cancel]");
    if (cancel) {
      const form = cancel.closest("form");
      if (form && form.dataset.adder !== undefined) return closeAdd();
      if (form) return toggleEditor(form.closest("li.item"));
    }
    const remove = target.closest("[data-delete]");
    if (remove) return deleteItem(remove);
    if (target.closest("[data-add-open]")) return openAdd();
    const forgive = target.closest("[data-forgive]");
    if (forgive) {
      if (!forgive.disabled) toggleForgive(forgive);
      return;
    }
    const mode = target.closest("[data-tip-mode]");
    if (mode) setTipMode(mode.dataset.tipMode);
  });

  root.addEventListener("submit", (event) => {
    const form = event.target;
    event.preventDefault();
    if (stopped || form._busy) return;
    if (form.dataset.field) saveField(form);
    else if (form.dataset.editor) saveItem(form);
    else if (form.dataset.adder !== undefined) addItem(form);
    else if (form.dataset.payerForm !== undefined) savePayer(form);
    else if (form.dataset.guestForm !== undefined) addGuest(form);
  });

  root.addEventListener("change", (event) => {
    const form = event.target instanceof Element ? event.target.closest("form[data-payer-form]") : null;
    if (form) render();
    const guest = event.target instanceof Element ? event.target.closest("form[data-guest-form]") : null;
    if (guest) guestReady(guest);
  });

  root.addEventListener("input", (event) => {
    const guest = event.target instanceof Element ? event.target.closest("form[data-guest-form]") : null;
    if (guest) {
      guest.querySelector(".editor-msg").textContent = "";
      guestReady(guest);
      return;
    }
    const form = event.target instanceof Element ? event.target.closest("form[data-field]") : null;
    if (!form) return;
    const note = form.querySelector("[data-note]");
    if (note._message) {
      note._message = null;
      note.textContent = "";
      note.style.color = "";
    }
    form.querySelector("button[type=submit]").disabled = form._busy || !isDirty(form);
    if (form.dataset.field === "tip") tipPreview(view());
  });

  // Polling keeps a shared page honest about other people's claims. A hidden
  // tab skips its turn and catches up the moment it is shown again.
  const timer = setInterval(poll, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") poll();
  });

  render();
  root.classList.add("is-live");
})();
`;
