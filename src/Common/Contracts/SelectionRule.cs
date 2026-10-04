using System.Text.Json.Serialization;

namespace Xpathed.Common.Contracts;

public sealed record SelectionRule(string Name, string Field, string Kind, string? Scope)
{
    [JsonIgnore]
    public bool IsValid =>
        !string.IsNullOrWhiteSpace(Name)
        && Name.Length <= 300
        && Field is "label" or "text"
        && Kind is "control" or "image" or "any"
        && (Scope is null || !string.IsNullOrWhiteSpace(Scope) && Scope.Length <= 300);

    public bool Matches(string tag, string role, string label, string text, string[] scope) =>
        IsValid
        && string.Equals(Field == "label" ? label : text, Name, StringComparison.Ordinal)
        && (Scope is null || scope.Contains(Scope, StringComparer.Ordinal))
        && Kind switch
        {
            "control" => tag is "a" or "button" or "input" or "select" or "textarea" or "summary"
                || role
                    is "button"
                        or "link"
                        or "checkbox"
                        or "radio"
                        or "switch"
                        or "textbox"
                        or "searchbox"
                        or "combobox"
                        or "listbox"
                        or "slider"
                        or "spinbutton"
                        or "menuitem"
                        or "menuitemcheckbox"
                        or "menuitemradio"
                        or "tab"
                        or "option"
                        or "scrollbar"
                        or "treeitem",
            "image" => tag == "img" || role == "img",
            "any" => true,
            _ => false,
        };

    public bool Matches(CandidateElement candidate) =>
        Matches(candidate.Tag, candidate.Role, candidate.Label, candidate.Text, candidate.Scope);
}
