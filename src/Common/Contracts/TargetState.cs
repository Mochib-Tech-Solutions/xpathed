namespace Xpathed.Common.Contracts;

public sealed record TargetState(bool Rendered, bool InViewport, bool Enabled, bool Editable, bool? Checked, string Version = "1", bool? AccessibilityExposed = null, bool? Readonly = null);
