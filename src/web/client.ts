// Shipped inline as plain browser JavaScript with no build step, so it is a
// string here rather than a module the Worker imports and runs. It must never
// contain a closing script tag, since it is pasted between script tags.
export const CLIENT_SCRIPT = `
(() => {
  "use strict";
  const root = document.getElementById("bill");
  const stateBlock = document.getElementById("bill-state");
  if (!root || !stateBlock) return;

  let state;
  try {
    state = JSON.parse(stateBlock.textContent || "");
  } catch {
    return;
  }

  // The server knows this visitor only by the signed token in the link, so
  // every later call to it carries the same token.
  const session = { state, token: new URLSearchParams(location.search).get("t") || "" };

  // Claiming is not wired up yet. Until it is, a tap changes nothing, rather
  // than showing a claim the server never saw.
  function onChipTap(session, chip) {}

  root.addEventListener("click", (event) => {
    const chip = event.target instanceof Element ? event.target.closest("button.chip") : null;
    if (!chip || chip.disabled || !root.contains(chip)) return;
    onChipTap(session, chip);
  });

  root.classList.add("is-live");
})();
`;
