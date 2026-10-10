const interactability = (element, action) => {
  const observed = state(element);
  const pointer = ["click", "double_click", "right_click", "hover", "check", "uncheck"].includes(
    action,
  );
  const editable = ["fill", "type", "clear"].includes(action);
  const keyboard = editable || ["select", "press", "focus", "blur", "upload"].includes(action);
  const rect = geometry(element);
  const hit = pointer && observed.inViewport && receivesPoint(element, pointFor(element));
  const semanticRole = role(element);
  const enabledApplies =
    !observed.enabled ||
    element.matches(":enabled,a[href],summary") ||
    element.isContentEditable ||
    [
      "button",
      "link",
      "checkbox",
      "radio",
      "switch",
      "textbox",
      "searchbox",
      "spinbutton",
      "combobox",
      "listbox",
      "slider",
      "scrollbar",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "option",
      "tab",
      "treeitem",
    ].includes(semanticRole) ||
    !!closest(element, "[aria-disabled]");
  const custom = editable
    ? !element.isContentEditable &&
      !element.matches("input,textarea") &&
      ["textbox", "searchbox", "spinbutton"].includes(semanticRole)
    : action === "select"
      ? element.localName !== "select" && ["combobox", "listbox"].includes(semanticRole)
      : ["check", "uncheck"].includes(action)
        ? !element.matches("input[type=checkbox],input[type=radio]") &&
          ["checkbox", "radio", "switch"].includes(semanticRole)
        : false;
  const compatible =
    custom ||
    (editable
      ? action === "type"
        ? textControl(element)
        : fillControl(element)
      : action === "select"
        ? element.localName === "select"
        : action === "upload"
          ? element.matches("input[type=file]")
          : ["focus", "blur", "press"].includes(action)
            ? element.isContentEditable ||
              element.matches("input,textarea,select,button,a[href],summary,[tabindex]")
            : ["check", "uncheck"].includes(action)
              ? element.matches("input[type=checkbox],input[type=radio]") &&
                !(action === "uncheck" && element.type === "radio")
              : true);
  const checks = {
    compatibleControl: custom ? "unknown" : compatible ? "pass" : "fail",
    enabled:
      ["hover", "inspect", "blur"].includes(action) || !enabledApplies
        ? "not_applicable"
        : observed.enabled
          ? "pass"
          : "fail",
    writable: editable ? (observed.readonly ? "fail" : "pass") : "not_applicable",
    viewport: pointer ? (observed.inViewport ? "pass" : "fail") : "not_applicable",
    pointerReception: !pointer
      ? "not_applicable"
      : !observed.inViewport
        ? "unknown"
        : hit
          ? "pass"
          : "fail",
    keyboard: !keyboard
      ? "not_applicable"
      : editable &&
          compatible &&
          !custom &&
          observed.enabled &&
          (element.matches("input,textarea") ||
            (element.isContentEditable && !parent(element)?.isContentEditable))
        ? "pass"
        : "unknown",
    stability: "unknown",
    eventOutcome: "unknown",
  };
  const reasons = [];
  if (!compatible) reasons.push("incompatible_control");
  if (custom) reasons.push("custom_control_unverified");
  if (checks.enabled === "fail") reasons.push("disabled");
  if (checks.writable === "fail") reasons.push("readonly");
  if (rect.width <= 0 || rect.height <= 0) reasons.push("zero_area");
  else if (!observed.inViewport) reasons.push("off_screen");
  if (!observed.rendered) reasons.push("not_visually_rendered");
  if (checks.pointerReception === "fail")
    reasons.push(
      getComputedStyle(element).pointerEvents === "none"
        ? "pointer_events_none"
        : "obstructed_at_hit_point",
    );
  const readiness = [
    checks.compatibleControl,
    checks.enabled,
    checks.writable,
    checks.viewport,
    checks.pointerReception,
    checks.keyboard,
  ];
  return {
    action,
    status: readiness.includes("fail")
      ? "blocked"
      : custom
        ? "unsupported"
        : readiness.includes("unknown")
          ? "unknown"
          : "ready",
    reasons,
    checks,
  };
};
const shape = (element) =>
  `${element.localName}:${[...element.children].map((child) => child.localName).join(",")}`;
