namespace Xpathed.Common.Contracts;

public sealed record TargetState(bool Rendered, bool InViewport, bool Enabled, bool Editable, bool? Checked);
