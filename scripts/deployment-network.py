"""Host-only packet isolation for the public Browser; never grant it NET_ADMIN.

Install this root-owned helper as a systemd service. The hosted entrypoint waits
for a nonce acknowledgement, so missing/failed isolation stops Browser startup.
Local development and evaluation do not use this entrypoint or policy.
"""
import ipaddress
import json
import re
import shlex
import subprocess
import sys
import time

CHAIN = "XPATHED_EGRESS"
CONTAINER = "xpathed-hosted-browser-1"
PRIVATE_V4 = ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
              "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
              "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24",
              "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4")


def command(*arguments, data=None):
    return subprocess.check_output(arguments, input=data, text=True, timeout=15,
                                   stderr=subprocess.DEVNULL).strip()


def browser():
    record = json.loads(command("docker", "inspect", CONTAINER))[0]
    labels = record["Config"]["Labels"]
    if (labels.get("com.docker.compose.project") != "xpathed-hosted"
            or labels.get("com.docker.compose.service") != "browser"
            or not record["State"]["Running"] or record["State"]["Pid"] <= 1):
        raise RuntimeError("Hosted Browser is not running")
    return record["Id"], record["State"]["Pid"]


def nonce(identity, name):
    value = command("docker", "exec", identity, "head", "-c", "65", f"/tmp/.xpathed-egress-{name}")
    if not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", value):
        raise RuntimeError("Browser isolation entrypoint is not waiting")
    return value


def host_addresses():
    addresses = json.loads(command("ip", "-json", "address", "show", "scope", "global"))
    return sorted({str(ipaddress.IPv4Address(info["local"])) for interface in addresses
                   for info in interface["addr_info"] if info.get("family") == "inet"})


def rules(version, addresses):
    # Replies to incoming API/viewer connections remain possible. ORIGINAL
    # private connections are rejected even if they existed before installation.
    result = [["-m", "conntrack", "--ctstate", "RELATED,ESTABLISHED", "--ctdir", "REPLY", "-j", "RETURN"]]
    if version == 4:
        # Docker's embedded DNS is DNATed before OUTPUT filtering. Match its
        # original destination, rather than permitting arbitrary loopback ports.
        for protocol in ("udp", "tcp"):
            result.append(["-p", protocol, "-m", "conntrack", "--ctorigdst", "127.0.0.11",
                           "--ctorigdstport", "53", "-j", "RETURN"])
        result += [["-d", destination, "-j", "REJECT"] for destination in (*PRIVATE_V4, *addresses)]
        result.append(["-j", "RETURN"])
    else:
        # The hosted network is IPv4-only. Fail closed for IPv6 (including
        # transition/tunnel addresses); public sites with IPv4 remain supported.
        result.append(["-j", "REJECT"])
    return result


def namespace(pid, *arguments, data=None):
    return command("nsenter", "--target", str(pid), "--net", "--", *arguments, data=data)


def install(pid, addresses):
    for version in (4, 6):
        tool = "iptables" if version == 4 else "ip6tables"
        planned = rules(version, addresses)
        # restore commits atomically: updating our chain never exposes a flushed
        # live chain, and no Docker-managed or unrelated chains are modified.
        contents = ["*filter", f":{CHAIN} - [0:0]", f"-F {CHAIN}"]
        contents += [shlex.join(["-A", CHAIN, *rule]) for rule in planned]
        namespace(pid, tool + "-restore", "--wait", "5", "--noflush",
                  data="\n".join([*contents, "COMMIT", ""]))
        try:
            namespace(pid, tool, "--wait", "5", "-C", "OUTPUT", "-j", CHAIN)
        except subprocess.CalledProcessError:
            namespace(pid, tool, "--wait", "5", "-I", "OUTPUT", "1", "-j", CHAIN)


def verify_policy(pid, addresses):
    for version in (4, 6):
        tool = "iptables" if version == 4 else "ip6tables"
        namespace(pid, tool, "--wait", "5", "-C", "OUTPUT", "-j", CHAIN)
        # Match ordered rules, including their narrow exemptions; the presence
        # of a deny rule alone cannot detect an earlier permissive rule.
        expected = [["-N", CHAIN]]
        for planned in rules(version, addresses):
            normalized = list(planned)
            if "-d" in normalized:
                index = normalized.index("-d") + 1
                normalized[index] = str(ipaddress.ip_network(normalized[index]))
            if "--dport" in normalized:
                index = normalized.index("--dport")
                normalized[index:index] = ["-m", "tcp"]
            if normalized[-1] == "REJECT":
                normalized += ["--reject-with", "icmp-port-unreachable" if version == 4 else "icmp6-port-unreachable"]
            expected.append(["-A", CHAIN, *normalized])
        observed = [shlex.split(line) for line in namespace(pid, tool, "--wait", "5", "-S", CHAIN).splitlines()]
        output = [shlex.split(line) for line in namespace(pid, tool, "--wait", "5", "-S", "OUTPUT").splitlines()]
        if observed != expected or output[1:2] != [["-A", "OUTPUT", "-j", CHAIN]]:
            raise RuntimeError("Browser network isolation is incomplete")


def reconcile(expected=None):
    identity, pid = browser()
    waiting = nonce(identity, "wait")
    if expected == (identity, pid, waiting):
        return expected
    addresses = host_addresses()
    install(pid, addresses)
    verify_policy(pid, addresses)
    # A container replacement during installation must never be released.
    if browser() != (identity, pid) or nonce(identity, "wait") != waiting:
        raise RuntimeError("Browser changed during network isolation")
    command("docker", "exec", identity, "sh", "-c",
            'printf "%s" "$1" > /tmp/.xpathed-egress-ready', "sh", waiting)
    return identity, pid, waiting


def verify():
    identity, pid = browser()
    verify_policy(pid, host_addresses())
    if nonce(identity, "wait") != nonce(identity, "ready") or browser() != (identity, pid):
        raise RuntimeError("Browser network isolation is not ready")


def serve():
    applied = None
    while True:
        try:
            candidate = reconcile(applied)
            if candidate != applied:
                print("Hosted Browser network isolation installed.", flush=True)
            applied = candidate
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, KeyError):
            # Never release startup on failure; log no container environment,
            # page content or credentials. Docker/systemd restart retries safely.
            applied = None
            print("Hosted Browser unavailable or awaiting network isolation.", flush=True)
        time.sleep(2)


if __name__ == "__main__":
    if sys.argv[1:] == ["--verify"]:
        verify()
    elif not sys.argv[1:]:
        serve()
    else:
        raise SystemExit("Usage: deployment-network.py [--verify]")
