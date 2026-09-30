namespace Xpathed.Common.Contracts;

public sealed record CandidateElement(string Id, string Tag, string Role, string Text, string Label, string Placeholder, string[] Scope, TargetState State, ElementGeometry Geometry);
