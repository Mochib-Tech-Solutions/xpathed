import type { ActionResolution, ResolutionResult } from "./api";

export function elementType(target: NonNullable<ResolutionResult["target"]>) {
  const names: Record<string, string> = {
    img: "Image",
    button: "Button",
    link: "Link",
    textbox: "Text field",
    searchbox: "Search field",
    combobox: "Dropdown",
    listbox: "List box",
    checkbox: "Checkbox",
    radio: "Radio button",
    spinbutton: "Number field",
    slider: "Slider",
    switch: "Switch",
    tab: "Tab",
    a: "Anchor",
    input: "Input",
    textarea: "Text field",
    select: "Dropdown",
    svg: "Graphic",
    video: "Video",
    audio: "Audio",
    canvas: "Canvas",
    iframe: "Frame",
  };
  const role =
    target.role && !["none", "presentation", "generic"].includes(target.role) ? target.role : null;
  return (
    names[role ?? target.tag] ??
    (role ? role[0]!.toUpperCase() + role.slice(1) : `Element <${target.tag}>`)
  );
}

export const interactionReasons: Record<string, string> = {
  disabled: "This element is disabled.",
  readonly: "This field is read-only.",
  incompatible_control: "This control does not support the requested action.",
  off_screen: "This element is off-screen.",
  zero_area: "The target has no area for a pointer interaction.",
  not_visually_rendered: "The target is exposed to accessibility but is not visually rendered.",
  pointer_events_none: "The target does not receive pointer events at the inspected point.",
  obstructed_at_hit_point: "Another element or clipping blocks the inspected pointer point.",
  custom_control_unverified: "Interaction with this custom control could not be verified.",
  ancestor_frame_obstructed: "An overlay or clipping blocks the target’s containing frame.",
};

export const instructionLimits: Record<string, string> = {
  ambiguous:
    "The instruction does not identify a unique target. Specify its exact name, section, or position, such as left or right.",
  current_state_dependency:
    "This command needs separate steps. Resolve one interaction in the current view, then request the next step after any required page change. No action was executed.",
  state_unavailable:
    "That form state is withheld from target selection. Identify the element by its label or position instead.",
  target_not_addressable:
    "That part of the graphic is not a separate page element. Request the whole graphic or a separately exposed element.",
  unsupported_action: "This interaction is not supported.",
};

export const instructionTitles: Record<string, string> = {
  ambiguous: "Ambiguous target",
  unsupported_action: "Unsupported interaction",
  current_state_dependency: "Separate steps required",
  appearance_unavailable: "Appearance unavailable",
  state_unavailable: "State unavailable",
  target_not_addressable: "Graphic detail unavailable",
  unsupported_scope: "Unsupported page content",
};

export const imageReasons: Record<string, string> = {
  text_only_requested: "You chose text only.",
  no_candidates: "There were no captured elements to inspect.",
  semantic_evidence: "Page text and structure appeared sufficient.",
  visual_evidence: "An image was chosen to help with visual details.",
  uncertain_route: "A screenshot could help clarify the available evidence.",
  router_unavailable: "The automatic image decision was unavailable.",
  image_unavailable: "A usable screenshot was unavailable.",
};

export function instructionLimit(
  action: ActionResolution,
  imageRouting: ResolutionResult["diagnostics"]["imageRouting"],
) {
  if (action.code === "appearance_unavailable") {
    if (imageRouting?.status === "unavailable")
      return "A screenshot was unavailable for this request. Identify the element by its label, section, or position.";
    if (imageRouting?.status === "text_only" && imageRouting.reason === "text_only_requested")
      return "That visual detail could not be established from page text and structure. Choose Auto screenshots, or specify a label, section, or position.";
    return "That visual detail could not be established from the current view. Specify a label, section, or position.";
  }
  const knownLimit = instructionLimits[action.code ?? ""];
  if (knownLimit && action.code !== "unsupported_action") return knownLimit;
  return (
    action.message ??
    knownLimit ??
    "This instruction cannot be resolved within the supported scope."
  );
}
