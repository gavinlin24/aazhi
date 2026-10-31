// Plain browser JavaScript shipped inline, like the bill page's script, so the
// same rules apply: no template literals, and never a closing script tag.
// The stats are already in the page, so for those it only chooses what shows.
// Your logs are the one thing here that writes.
export const PROFILE_SCRIPT = String.raw`
(() => {
  "use strict";
  const page = document.getElementById("profile") || document.getElementById("boards");
  if (!page) return;
  page.classList.add("is-live");

  function pick(peak) {
    const card = peak.closest(".range-card");
    const i = peak.dataset.peak;
    card.querySelectorAll("[data-l]").forEach((text) => text.toggleAttribute("hidden", text.dataset.l !== i));
    card.querySelectorAll("[data-m]").forEach((text) => text.classList.toggle("now", text.dataset.m === i));
    card.querySelector(".hero-sub").textContent = peak.dataset.line;
  }

  const token = new URLSearchParams(location.search).get("t") || "";

  async function changeLog(row, method, body) {
    const logs = row.closest("[data-logs]");
    let response = null;
    try {
      response = await fetch("/g/" + encodeURIComponent(logs.dataset.logs) + "/logs/" + encodeURIComponent(row.dataset.log), {
        method,
        cache: "no-store",
        headers: Object.assign({ authorization: "Bearer " + token }, body ? { "content-type": "application/json" } : {}),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      response = null;
    }
    const data = response ? await response.json().catch(() => null) : null;
    const failed = !response || !response.ok;
    if (!failed) return data;
    let msg = row.querySelector(".log-msg");
    if (!msg) {
      msg = document.createElement("p");
      msg.className = "log-msg";
      msg.setAttribute("role", "status");
      row.append(msg);
    }
    msg.textContent = (data && data.error) || "That didn't go through. Try again in a minute.";
    return null;
  }

  async function removeLog(button) {
    if (!button.classList.contains("is-armed")) {
      button.classList.add("is-armed");
      button.textContent = "Tap again";
      setTimeout(() => {
        button.classList.remove("is-armed");
        button.textContent = "Remove";
      }, 4000);
      return;
    }
    const row = button.closest("[data-log]");
    const done = await changeLog(row, "DELETE");
    if (!done) return;
    const card = row.closest("[data-logs]");
    if (done.postLeft) {
      row.replaceChildren(Object.assign(document.createElement("p"), { className: "log-msg", textContent: "Removed, but I couldn't remove the post." }));
      return;
    }
    row.remove();
    if (!card.querySelector("[data-log]")) card.remove();
  }

  function renameLog(button) {
    const row = button.closest("[data-log]");
    if (row.querySelector("form")) return;
    const name = row.querySelector(".log-place");
    const input = Object.assign(document.createElement("input"), { name: "place", value: name.textContent, maxLength: 80, autocomplete: "off" });
    input.setAttribute("aria-label", "New name");
    const save = Object.assign(document.createElement("button"), { type: "submit", className: "log-btn", textContent: "Save" });
    const form = Object.assign(document.createElement("form"), { className: "log-form" });
    form.append(input, save);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const done = await changeLog(row, "PATCH", { place: input.value });
      if (!done) return;
      name.textContent = done.place;
      form.remove();
    });
    row.append(form);
    input.select();
  }

  page.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const peak = event.target.closest("[data-peak]");
    if (peak) return pick(peak);
    const remove = event.target.closest("[data-log-remove]");
    if (remove) return removeLog(remove);
    const rename = event.target.closest("[data-log-rename]");
    if (rename) return renameLog(rename);
    const link = event.target.closest("[data-tab], [data-to]");
    if (!link) return;
    event.preventDefault();
    if (link.dataset.tab) page.dataset.board = link.dataset.tab;
    if (link.dataset.to) page.dataset.span = link.dataset.to;
    showBoard();
  });

  page.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-peak]")) {
      event.preventDefault();
      pick(event.target);
    }
  });

  // The address follows the tabs, so coming back from a profile lands on the
  // board that was open.
  function showBoard() {
    const { board, span } = page.dataset;
    page.querySelectorAll("[data-list]").forEach((list) => {
      list.hidden = list.dataset.list !== board + ":" + span;
    });
    page.querySelectorAll("[data-foot]").forEach((foot) => {
      foot.hidden = foot.dataset.foot !== board;
    });
    page.querySelectorAll("[data-tab]").forEach((tab) => tab.classList.toggle("on", tab.dataset.tab === board));
    page.querySelectorAll("[data-to]").forEach((tab) => tab.classList.toggle("on", tab.dataset.to === span));
    // These tabs were drawn for the board the page opened on.
    page.querySelectorAll("[data-keep]").forEach((tab) => {
      const link = new URL(tab.href);
      link.searchParams.set("board", board);
      link.searchParams.set("span", span);
      tab.href = link;
    });
    const address = new URL(location.href);
    address.searchParams.set("board", board);
    address.searchParams.set("span", span);
    history.replaceState(null, "", address);
  }
})();
`;
