// Two levels: providers, then the hovered provider's models beside them. One flat
// list of every provider's models had to scroll once OpenCode arrived.

import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { MenuGlyph, highlightMatch, moveMenuFocus } from "./context-menu-react.js";
import { placeFlyout } from "./context-menu-position.js";
import { modelSections, searchModelOptions } from "./model-picker-model.js";
import { providerMarkSlot } from "./provider-mark.js";
import { MenuPortal, placementBounds, useAnchoredMenu } from "./use-anchored-menu.js";
import { useDismissableMenu } from "./use-dismissable-menu.js";
import { CHECK_SVG, CHEVRON_DOWN_SVG, CHEVRON_RIGHT_SVG, SEARCH_SVG } from "../svg.js";

const h = React.createElement;

const ITEM_SELECTOR =
  '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)';
// Long enough that a diagonal move into the flyout does not switch provider on the way.
const HOVER_SWITCH_MS = 120;

function initialProvider(groups, selectedProvider) {
  const choosable = groups.filter((group) => !group.direct);
  return (
    choosable.find((group) => group.provider === selectedProvider)?.provider
    || choosable.find((group) => group.options.some((option) => option.selected))?.provider
    || choosable[0]?.provider
    || ""
  );
}

function providerRowNode(menu, provider) {
  return [...(menu?.querySelectorAll("[data-provider-row]") || [])].find(
    (node) => node.dataset.providerRow === provider
  );
}

// Focus is moved with preventScroll, which keeps the page and dialog still, so the
// menu has to bring the row into its own scroll area itself.
function revealInPanel(node) {
  const panel = node?.closest?.(".context-menu");
  if (!panel) return;
  const room = panel.getBoundingClientRect();
  const box = node.getBoundingClientRect();
  const inset = 4;
  if (box.top < room.top + inset) {
    panel.scrollTop -= room.top + inset - box.top;
  } else if (box.bottom > room.bottom - inset) {
    panel.scrollTop += box.bottom - (room.bottom - inset);
  }
}

function typedCharacter(event) {
  return (
    event.key.length === 1
    && !event.ctrlKey
    && !event.metaKey
    && !event.altKey
  );
}

function ModelRow({ onChoose, option, query = "", lead = null }) {
  return h(
    "button",
    {
      "aria-checked": option.selected ? "true" : "false",
      className: "context-menu-button model-picker-option" + (option.selected ? " is-selected" : ""),
      "data-provider": option.provider || undefined,
      "data-value": option.value,
      onClick: () => onChoose(option),
      role: "menuitemradio",
      type: "button",
    },
    lead || h(MenuGlyph, { className: "context-menu-lead", svg: option.selected ? CHECK_SVG : "" }),
    h("span", { className: "context-menu-label" }, query ? highlightMatch(option.label, query) : option.label),
    option.tag ? h("span", { className: "context-menu-hint" }, option.tag) : null
  );
}

function ModelList({ group, otherOpen, onChoose, onToggleOther }) {
  const { other, sections } = modelSections(group.options);
  const showOther = otherOpen || other.some((option) => option.selected);
  const rows = [];
  if (group.empty) {
    // A note beside the choosable row, not a replacement for it.
    rows.push(
      h("p", { className: "context-menu-note", key: "empty" }, "Catalogue unavailable — the relay will pick")
    );
  }
  sections.forEach((section, index) => {
    if (index > 0) rows.push(h("div", { className: "context-menu-separator", key: `sep-${index}`, role: "separator" }));
    if (section.heading) {
      rows.push(
        h("div", { "aria-hidden": "true", className: "context-menu-heading model-picker-heading", key: `head-${index}` }, section.heading)
      );
    }
    for (const option of section.options) {
      rows.push(h(ModelRow, { key: `option:${option.value}`, onChoose, option }));
    }
  });
  if (other.length) {
    rows.push(h("div", { className: "context-menu-separator", key: "sep-other", role: "separator" }));
    rows.push(
      h(
        "button",
        {
          "aria-expanded": showOther ? "true" : "false",
          className: "context-menu-button is-muted model-picker-other",
          key: "other",
          onClick: onToggleOther,
          role: "menuitem",
          type: "button",
        },
        h(MenuGlyph, { className: "context-menu-lead", svg: "" }),
        h("span", { className: "context-menu-label" }, "Other models"),
        h("span", { className: "context-menu-hint" }, String(other.length)),
        h(MenuGlyph, { className: "context-menu-chevron model-picker-other-caret", svg: CHEVRON_DOWN_SVG })
      )
    );
    if (showOther) {
      for (const option of other) {
        rows.push(h(ModelRow, { key: `option:${option.value}`, onChoose, option }));
      }
    }
  }
  return rows;
}

export function ModelPicker({
  ariaLabel = "Model",
  className = "",
  disabled = false,
  // From buildModelPickerGroups. A group with `direct: true` is one row chosen at
  // the first level (the fork's "Inherit from source").
  groups = [],
  id = null,
  inherited = false,
  onOpen = null,
  onSelect = null,
  // The provider whose logo the trigger shows, and whose models open first.
  provider = "",
  tag = null,
  value,
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState("");
  const [query, setQuery] = useState("");
  const [otherOpen, setOtherOpen] = useState(() => new Set());
  // No room beside the menu (a phone): the models replace the provider list.
  const [drill, setDrill] = useState(false);
  const [drilled, setDrilled] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const layerRef = useRef(null);
  const menuRef = useRef(null);
  const flyoutRef = useRef(null);
  const searchRef = useRef(null);
  const focusIntent = useRef(null);
  // A focus request must commit even when nothing else changed (→ on the active provider).
  const [, setFocusRequest] = useState(0);
  const requestFocus = (intent) => {
    focusIntent.current = intent;
    setFocusRequest((count) => count + 1);
  };
  const hoverTimer = useRef(null);
  // What has focus, kept in view until the user scrolls for themselves.
  const revealRef = useRef(null);
  // Where focus was, so a re-render that removes that row can put it back.
  const lastFocus = useRef(null);
  // What a pointer is pressing, until its click has been handled.
  const pressed = useRef(null);
  const menuId = useId();

  const clearHover = () => {
    clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  const close = useCallback(() => {
    clearTimeout(hoverTimer.current);
    setOpen(false);
  }, []);
  // Escape would otherwise drop focus on <body> along with the unmounted row.
  const dismiss = useCallback(() => {
    const hadFocus = layerRef.current?.contains(layerRef.current.ownerDocument.activeElement);
    close();
    if (hadFocus) triggerRef.current?.focus({ preventScroll: true });
  }, [close]);

  useDismissableMenu({ menuRef: layerRef, onClose: dismiss, open, rootRef });
  const assignMenuRef = useAnchoredMenu({ menuRef, open, triggerRef });
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const openMenu = () => {
    onOpen?.();
    setActive(initialProvider(groups, provider));
    setQuery("");
    setOtherOpen(new Set());
    setDrill(false);
    setDrilled(false);
    requestFocus("provider");
    setOpen(true);
  };

  const choose = (option, group = null) => {
    close();
    onSelect?.(option.value, { ...option, provider: option.provider || group?.provider || "" });
    triggerRef.current?.focus({ preventScroll: true });
  };

  const enterProvider = (next) => {
    clearHover();
    setActive(next);
    if (drill) setDrilled(true);
    requestFocus("models");
  };

  const activeGroup = groups.find((group) => group.provider === active && !group.direct) || null;
  // A thread's composer can only move within its own provider: no provider level.
  const single = groups.length === 1 && !groups[0].direct;
  const results = query ? searchModelOptions(groups, query) : [];
  const showFlyout = open && !query && !drill && !single && Boolean(activeGroup);

  // Panel 1 is placed by useAnchoredMenu in an earlier layout effect, so its rect
  // is final by the time this runs.
  const placeFlyoutPanel = useCallback(() => {
    const menu = menuRef.current;
    const flyout = flyoutRef.current;
    if (!menu || !flyout || menu.dataset.placed !== "true") return;
    const view = flyout.ownerDocument?.defaultView;
    if (!view) return;
    // Measuring uncapped clamps the list's scroll to the top; put it back afterwards.
    const scrolled = flyout.scrollTop;
    flyout.style.left = "0px";
    flyout.style.top = "0px";
    flyout.style.maxHeight = "";
    flyout.style.maxWidth = "";
    const declared = Number.parseFloat(view.getComputedStyle(flyout).maxHeight);
    const selfCap = Number.isFinite(declared) ? declared : Infinity;
    flyout.style.maxHeight = "none";
    const origin = flyout.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    const bounds = placementBounds(view, flyout);
    const placed = placeFlyout({
      alignBottom: menu.dataset.placement === "above",
      height: Math.min(origin.height, selfCap),
      menu: {
        bottom: box.bottom - bounds.top,
        left: box.left - bounds.left,
        right: box.right - bounds.left,
        top: box.top - bounds.top,
      },
      minWidth: Number.parseFloat(view.getComputedStyle(flyout).minWidth) || origin.width,
      viewportHeight: bounds.height,
      viewportWidth: bounds.width,
      width: origin.width,
    });
    if (!placed.fits) {
      setDrill(true);
      setDrilled(true);
      // Follow focus into the drill-in only if it was ours; a resize must not pull it back.
      const doc = flyout.ownerDocument;
      const active = doc.activeElement;
      if (!active || active === doc.body || layerRef.current?.contains(active)) {
        focusIntent.current = "models";
      }
      return;
    }
    flyout.style.left = `${Math.round(placed.left + bounds.left - origin.left)}px`;
    flyout.style.top = `${Math.round(placed.top + bounds.top - origin.top)}px`;
    flyout.style.maxHeight = `${Math.round(Math.min(selfCap, placed.maxHeight))}px`;
    flyout.style.maxWidth = `${Math.floor(placed.width)}px`;
    flyout.scrollTop = scrolled;
    // Focus is still on the provider row, so nothing else would bring the chosen model into view.
    if (flyout.dataset.placed !== "true") revealInPanel(flyout.querySelector('[aria-checked="true"]'));
    flyout.dataset.side = placed.side;
    flyout.dataset.placed = "true";
  }, []);

  useLayoutEffect(() => {
    if (showFlyout) placeFlyoutPanel();
  });

  useEffect(() => {
    if (!showFlyout) return undefined;
    const view = flyoutRef.current?.ownerDocument?.defaultView;
    if (!view) return undefined;
    // Panel 1 moves outside React (resize, scroll, its own content), and this one follows.
    // Scrolling either list moves neither panel.
    const replace = (event) => {
      if (event?.type === "scroll" && layerRef.current?.contains(event.target)) return;
      placeFlyoutPanel();
    };
    view.addEventListener("resize", replace);
    view.addEventListener("scroll", replace, true);
    const observer = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(replace) : null;
    if (observer) {
      if (menuRef.current) observer.observe(menuRef.current);
      if (flyoutRef.current) observer.observe(flyoutRef.current);
    }
    return () => {
      view.removeEventListener("resize", replace);
      view.removeEventListener("scroll", replace, true);
      observer?.disconnect();
    };
  }, [placeFlyoutPanel, showFlyout]);

  useLayoutEffect(() => {
    const intent = focusIntent.current;
    const menu = menuRef.current;
    if (!open || !intent || !menu) return;
    focusIntent.current = null;
    const focus = (node) => node?.focus({ preventScroll: true });
    if (intent === "search") {
      focus(searchRef.current);
      return;
    }
    if (intent === "provider" && !(drill && drilled) && !single) {
      focus(providerRowNode(menu, active) || menu.querySelector(ITEM_SELECTOR));
      return;
    }
    const panel = drill || single ? menu : flyoutRef.current;
    // An unplaced panel is either not committed yet or about to give way to the drill-in.
    if (!drill && !single && panel?.dataset.placed !== "true") {
      focusIntent.current = intent;
      return;
    }
    focus(panel?.querySelector('[aria-checked="true"]') || panel?.querySelector(ITEM_SELECTOR));
  });

  // A catalogue arriving, or a search starting, can remove the focused row. Focus goes
  // to the same model if it is still listed, else to its panel, never to <body>.
  useLayoutEffect(() => {
    const last = lastFocus.current;
    const menu = menuRef.current;
    const layer = layerRef.current;
    if (!open || !last || !menu || !layer || last.node.isConnected) return;
    // Only focus that fell to <body> with its row; focus the user moved elsewhere stays there.
    const active = layer.ownerDocument.activeElement;
    if (active && active !== layer.ownerDocument.body) return;
    const same = [...layer.querySelectorAll("[data-value], [data-provider-row]")].find((node) =>
      last.row
        ? node.dataset.providerRow === last.row
        : node.dataset.value === last.value && (node.dataset.provider || "") === last.provider
    );
    const panel = last.inModels && !drill ? flyoutRef.current : menu;
    const target =
      same
      || panel?.querySelector('[aria-checked="true"]')
      || panel?.querySelector(ITEM_SELECTOR)
      || menu.querySelector(ITEM_SELECTOR)
      || searchRef.current;
    target?.focus({ preventScroll: true });
  });

  // A re-render can move the focused row (a catalogue refresh inserting above it)
  // without either panel changing size.
  useLayoutEffect(() => {
    const node = revealRef.current;
    if (open && node?.isConnected && node === node.ownerDocument.activeElement) revealInPanel(node);
  });

  const noteFocus = (event) => {
    const node = event.target;
    lastFocus.current = {
      inModels: Boolean(flyoutRef.current?.contains(node)),
      node,
      provider: node.dataset?.provider || "",
      row: node.dataset?.providerRow || "",
      value: node.dataset?.value,
    };
    revealRef.current = node;
    // Scrolling the row being pressed moves another row under the pointer before the click lands.
    if (!pressed.current?.isConnected || !node.contains(pressed.current)) revealInPanel(node);
  };

  useEffect(() => {
    const menu = menuRef.current;
    const layer = layerRef.current;
    const view = menu?.ownerDocument?.defaultView;
    if (!open || !menu || !layer || !view) return undefined;
    // Either panel is re-placed when its content or the window changes, which can
    // push the focused row back out of sight.
    const keep = () => {
      const node = revealRef.current;
      if (node?.isConnected && node === node.ownerDocument.activeElement) revealInPanel(node);
    };
    const observer = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(keep) : null;
    observer?.observe(menu);
    if (flyoutRef.current) observer?.observe(flyoutRef.current);
    const forget = () => {
      revealRef.current = null;
    };
    layer.addEventListener("wheel", forget, { passive: true });
    layer.addEventListener("touchmove", forget, { passive: true });
    return () => {
      observer?.disconnect();
      layer.removeEventListener("wheel", forget);
      layer.removeEventListener("touchmove", forget);
    };
  }, [open, showFlyout, active]);

  const onKeyDown = (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.target === searchRef.current) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        menuRef.current?.querySelector(ITEM_SELECTOR)?.focus({ preventScroll: true });
      } else if (event.key === "Enter" && results[0]) {
        event.preventDefault();
        choose(results[0]);
      }
      return;
    }
    const inFlyout = flyoutRef.current?.contains(event.target);
    if (moveMenuFocus(inFlyout ? flyoutRef.current : menuRef.current, event.key)) {
      event.preventDefault();
      return;
    }
    const row = event.target.closest?.("[data-provider-row]");
    if (event.key === "ArrowRight" && row) {
      event.preventDefault();
      enterProvider(row.dataset.providerRow);
    } else if (event.key === "ArrowLeft" && (inFlyout || (drill && drilled))) {
      event.preventDefault();
      setDrilled(false);
      requestFocus("provider");
    } else if (typedCharacter(event) && (query || event.key !== " ")) {
      event.preventDefault();
      setQuery((current) => current + event.key);
      requestFocus("search");
    }
  };

  const providerRow = (group) => {
    const isActive = group.provider === active && !query;
    const isCurrent = group.provider === provider;
    return h(
      "button",
      {
        "aria-expanded": isActive && showFlyout ? "true" : "false",
        "aria-haspopup": "menu",
        className:
          "context-menu-button model-picker-provider"
          + (isActive && showFlyout ? " is-highlighted" : "")
          + (isCurrent ? " is-current" : ""),
        "data-provider-row": group.provider,
        key: group.provider,
        onClick: () => enterProvider(group.provider),
        onFocus: () => {
          if (!drill) setActive(group.provider);
        },
        onMouseEnter: () => {
          if (drill || group.provider === active) return;
          clearHover();
          hoverTimer.current = setTimeout(() => {
            const flyout = flyoutRef.current;
            const focusWasInModels = flyout?.contains(flyout.ownerDocument.activeElement);
            setActive(group.provider);
            if (focusWasInModels) requestFocus("provider");
          }, HOVER_SWITCH_MS);
        },
        onMouseLeave: clearHover,
        role: "menuitem",
        type: "button",
      },
      providerMarkSlot(group.provider, { className: "model-picker-mark" }),
      h("span", { className: "context-menu-label" }, group.label),
      group.hint ? h("span", { className: "context-menu-hint" }, group.hint) : null,
      h(MenuGlyph, { className: "context-menu-chevron", svg: CHEVRON_RIGHT_SVG })
    );
  };

  const directRow = (group) => {
    const option = group.options[0];
    return h(
      "button",
      {
        "aria-checked": option.selected ? "true" : "false",
        className: "context-menu-button model-picker-direct" + (option.selected ? " is-selected" : ""),
        "data-value": option.value,
        key: group.provider,
        onClick: () => choose(option, group),
        role: "menuitemradio",
        type: "button",
      },
      h(MenuGlyph, { className: "context-menu-lead model-picker-mark", svg: option.selected ? CHECK_SVG : "" }),
      h("span", { className: "context-menu-label" }, option.label),
      group.hint ? h("span", { className: "context-menu-hint" }, group.hint) : null
    );
  };

  const searchBox = () =>
    h(
      "label",
      { className: "context-menu-filter", key: "filter" },
      h(MenuGlyph, { svg: SEARCH_SVG }),
      h("input", {
        "aria-label": "Search models or providers",
        autoComplete: "off",
        onChange: (event) => {
          setQuery(event.target.value);
          requestFocus("search");
        },
        placeholder: "Search models or providers",
        ref: searchRef,
        spellCheck: false,
        type: "text",
        value: query,
      })
    );

  let firstLevel;
  if (query) {
    firstLevel = [
      searchBox(),
      results.length
        ? results.map((option) =>
            h(ModelRow, {
              key: `${option.provider}:${option.value}`,
              lead: single ? null : providerMarkSlot(option.provider, { className: "model-picker-mark" }),
              onChoose: choose,
              option,
              query,
            })
          )
        : h("p", { className: "context-menu-note", key: "none" }, "No models match"),
    ];
  } else if (single && activeGroup) {
    firstLevel = [
      searchBox(),
      ...ModelList({
        group: activeGroup,
        onChoose: (option) => choose(option, activeGroup),
        onToggleOther: () => toggleOther(activeGroup.provider),
        otherOpen: otherOpen.has(activeGroup.provider),
      }),
    ];
  } else if (drill && drilled && activeGroup) {
    firstLevel = [
      searchBox(),
      h(
        "button",
        {
          className: "context-menu-button model-picker-back",
          key: "back",
          onClick: () => {
            setDrilled(false);
            requestFocus("provider");
          },
          role: "menuitem",
          type: "button",
        },
        h(MenuGlyph, { className: "context-menu-chevron model-picker-back-caret", svg: CHEVRON_RIGHT_SVG }),
        providerMarkSlot(activeGroup.provider, { className: "model-picker-mark" }),
        h("span", { className: "context-menu-label" }, activeGroup.label)
      ),
      h("div", { className: "context-menu-separator", key: "back-sep", role: "separator" }),
      ...ModelList({
        group: activeGroup,
        onChoose: (option) => choose(option, activeGroup),
        onToggleOther: () => toggleOther(activeGroup.provider),
        otherOpen: otherOpen.has(activeGroup.provider),
      }),
    ];
  } else {
    const direct = groups.filter((group) => group.direct);
    firstLevel = [
      searchBox(),
      ...direct.map(directRow),
      direct.length ? h("div", { className: "context-menu-separator", key: "direct-sep", role: "separator" }) : null,
      ...groups.filter((group) => !group.direct).map(providerRow),
    ];
  }

  function toggleOther(key) {
    setOtherOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return h(
    "div",
    {
      className:
        "setting-pill model-picker" + (inherited ? " is-inherited" : "") + (className ? ` ${className}` : ""),
      ref: rootRef,
    },
    h(
      "button",
      {
        "aria-controls": open ? menuId : undefined,
        "aria-expanded": open ? "true" : "false",
        "aria-haspopup": "menu",
        className: "setting-pill-trigger model-picker-trigger",
        disabled: disabled || undefined,
        id: id || undefined,
        onClick: () => (open ? close() : openMenu()),
        onKeyDown: (event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openMenu();
          }
        },
        ref: triggerRef,
        type: "button",
      },
      h("span", { className: "sr-only" }, `${ariaLabel}: `),
      providerMarkSlot(provider, { className: "model-picker-trigger-mark" }),
      h("span", { className: "setting-pill-value" }, value),
      tag ? h("span", { className: "setting-pill-tag" }, tag) : null,
      h(MenuGlyph, { className: "model-picker-caret", svg: CHEVRON_DOWN_SVG })
    ),
    h(
      MenuPortal,
      { anchorRef: triggerRef, open },
      h(
        "div",
        {
          className: "model-picker-layer",
          onClick: () => setTimeout(() => (pressed.current = null), 0),
          onFocus: noteFocus,
          onKeyDown: (event) => {
            pressed.current = null;
            onKeyDown(event);
          },
          onPointerDown: (event) => {
            pressed.current = event.target;
            // A press on the panel itself is its scrollbar: the user is scrolling.
            if (event.target.classList?.contains("context-menu")) revealRef.current = null;
          },
          ref: layerRef,
        },
        h(
          "div",
          {
            "aria-label": ariaLabel,
            className: "context-menu model-picker-menu" + (query ? " is-searching" : "") + (single ? " is-single" : ""),
            id: menuId,
            ref: assignMenuRef,
            role: "menu",
          },
          firstLevel
        ),
        showFlyout
          ? h(
              "div",
              {
                "aria-label": `${activeGroup.label} models`,
                className: "context-menu context-menu-submenu model-picker-flyout",
                "data-provider": activeGroup.provider,
                key: activeGroup.provider,
                ref: flyoutRef,
                role: "menu",
              },
              ModelList({
                group: activeGroup,
                onChoose: (option) => choose(option, activeGroup),
                onToggleOther: () => toggleOther(activeGroup.provider),
                otherOpen: otherOpen.has(activeGroup.provider),
              })
            )
          : null
      )
    )
  );
}
