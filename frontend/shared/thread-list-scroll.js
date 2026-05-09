export function installThreadListWheelProxy({
  root,
  scrollElement,
  shouldProxyWheel = () => true,
} = {}) {
  if (!root || !scrollElement) {
    return () => {};
  }

  const onWheel = (event) => {
    if (!shouldProxyWheel(event) || scrollElement.contains(event.target)) {
      return;
    }

    const before = scrollElement.scrollTop;
    scrollElement.scrollTop += event.deltaY;
    if (scrollElement.scrollTop === before) {
      return;
    }

    event.preventDefault();
    scrollElement.dispatchEvent(new Event("scroll"));
  };

  root.addEventListener("wheel", onWheel, { passive: false });
  return () => {
    root.removeEventListener("wheel", onWheel);
  };
}
