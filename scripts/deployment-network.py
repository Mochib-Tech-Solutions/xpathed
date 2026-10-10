"""Root-owned nftables policy for the dedicated native Browser account."""

import hashlib
import ipaddress
import json
import pwd
import socket
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

TABLE = "xpathed"
RECEIPT = Path("/run/xpathed-network.json")
PRIVATE_V4 = (
    "0.0.0.0/8",
    "10.0.0.0/8",
    "100.64.0.0/10",
    "127.0.0.0/8",
    "169.254.0.0/16",
    "172.16.0.0/12",
    "192.0.0.0/24",
    "192.0.2.0/24",
    "192.88.99.0/24",
    "192.168.0.0/16",
    "198.18.0.0/15",
    "198.51.100.0/24",
    "203.0.113.0/24",
    "224.0.0.0/4",
    "240.0.0.0/4",
)


def command(*arguments, data=None):
    return subprocess.check_output(arguments, input=data, text=True, timeout=15).strip()


def rules(uid, addresses):
    if not isinstance(uid, int) or uid <= 0:
        raise ValueError("Browser requires a dedicated nonroot account")
    blocked = [*PRIVATE_V4, *(str(ipaddress.IPv4Address(value)) for value in addresses)]
    return "\n".join(
        [
            f"table inet {TABLE} {{",
            " chain output {",
            "  type filter hook output priority -10; policy accept;",
            f"  meta skuid {uid} jump browser",
            " }",
            " chain browser {",
            "  ct direction reply ct state established,related accept",
            "  ip daddr 127.0.0.53 udp dport 53 accept",
            "  ip daddr 127.0.0.53 tcp dport 53 accept",
            "  meta nfproto ipv6 reject",
            "  fib daddr type local reject",
            "  ip daddr { " + ", ".join(blocked) + " } reject",
            "  return",
            " }",
            "}",
            "",
        ]
    )


def policy():
    # Handles are assigned by the kernel and do not alter rule semantics.
    record = json.loads(command("nft", "--json", "list", "table", "inet", TABLE))
    return [
        {kind: {key: value for key, value in body.items() if key != "handle"}}
        for item in record["nftables"]
        for kind, body in item.items()
        if kind != "metainfo"
    ]


def signature():
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def install():
    uid = pwd.getpwnam("xpathed-browser").pw_uid
    hostname = urlsplit(Path("/etc/xpathed/public-url").read_text().strip()).hostname
    addresses = sorted(set(socket.gethostbyname_ex(hostname)[2]))
    contents = rules(uid, addresses)
    exists = (
        subprocess.run(
            ["nft", "list", "table", "inet", TABLE],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        == 0
    )
    # Delete and recreate only our table in one atomic netlink transaction.
    transaction = (f"delete table inet {TABLE}\n" if exists else "") + contents
    command("nft", "--check", "--file", "-", data=transaction)
    command("nft", "--file", "-", data=transaction)
    receipt = {"uid": uid, "source": signature(), "policy": policy()}
    RECEIPT.write_text(json.dumps(receipt))
    RECEIPT.chmod(0o600)
    verify()


def verify():
    receipt = json.loads(RECEIPT.read_text())
    if (
        receipt["uid"] != pwd.getpwnam("xpathed-browser").pw_uid
        or receipt["source"] != signature()
        or receipt["policy"] != policy()
    ):
        raise RuntimeError("Browser network isolation is incomplete")


if __name__ == "__main__":
    if sys.argv[1:] == ["--install"]:
        install()
    elif sys.argv[1:] == ["--verify"]:
        verify()
    else:
        raise SystemExit("Usage: deployment-network.py --install|--verify")
