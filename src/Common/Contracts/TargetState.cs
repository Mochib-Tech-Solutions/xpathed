namespace Xpathed.Common.Contracts;

public sealed record TargetState(
    bool Rendered,
    bool InViewport,
    bool Enabled,
    bool Editable,
    bool? Checked,
    bool? AccessibilityExposed = null,
    bool? Readonly = null,
    bool? Selected = null,
    int? SelectedOptionCount = null
);
