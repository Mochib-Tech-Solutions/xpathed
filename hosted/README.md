# Hosted browser

The hosted service uses the official Chrome headless shell. Deployment downloads
the version matching the host's maintained Google Chrome package and bundles it
in the immutable release, so rollback restores the browser binary too. A failed
download cannot switch the running release.

The AppArmor rule grants user namespace access only to the exact root-owned
release executable. Chromium's sandbox, site isolation, network restrictions and
systemd protections stay enabled. Each session still owns a separate process and
temporary profile; disconnect and idle cleanup release both.

Headless shell supports the application's viewer, tabs, popups, capture, input,
dialogs and media codecs. It has no built-in PDF viewer. Page console history is
discarded because DevTools otherwise retains logged objects without any feature
using them.
