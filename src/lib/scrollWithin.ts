// Like scrollIntoView, but scrolls only `container`. scrollIntoView also scrolls every scrollable ancestor, the page
// included, which can slide the whole app out of the window.
export function scrollWithin(container: HTMLElement, el: HTMLElement, block: "nearest" | "center", behavior: ScrollBehavior = "auto") {
  const box = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const above = r.top - box.top;
  const below = r.bottom - box.bottom;
  let by = 0;
  if (block === "center") by = above - (container.clientHeight - r.height) / 2;
  else if (above < 0) by = above;
  else if (below > 0) by = below;
  if (by) container.scrollTo({ top: container.scrollTop + by, behavior });
}
