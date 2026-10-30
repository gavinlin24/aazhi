// Plain browser JavaScript shipped inline, like the bill page's script, so the
// same rules apply: no template literals, and never a closing script tag.
// Everything here is already in the page, so it only chooses what shows.
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

  page.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const peak = event.target.closest("[data-peak]");
    if (peak) return pick(peak);
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
    const address = new URL(location.href);
    address.searchParams.set("board", board);
    address.searchParams.set("span", span);
    history.replaceState(null, "", address);
  }
})();
`;
