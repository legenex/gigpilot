import { isIP } from "node:net";

/**
 * IP classification for the SSRF guard. Anything that is not a globally
 * routable unicast address is treated as private/blocked: loopback, RFC1918,
 * CGNAT (100.64/10 — includes Tailscale), link-local (incl. cloud metadata
 * 169.254.169.254), multicast, reserved, documentation, and IPv6 equivalents
 * (ULA, link-local, IPv4-mapped/compatible, NAT64, 6to4 and Teredo wrappers
 * are unwrapped or blocked).
 */

function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT / Tailscale
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local + metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

const V4_RANGES = V4_BLOCKS.map(([base, bits]) => {
  const b = parseIPv4(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (b & mask) >>> 0, mask };
});

function isPrivateV4(n: number): boolean {
  return V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.net);
}

/** Parse IPv6 into 8 16-bit groups (supports "::" and embedded dotted IPv4). */
export function parseIPv6(input: string): number[] | null {
  let ip = input;
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  let tailV4: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (v4 === null) return null;
    tailV4 = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    ip = ip.slice(0, lastColon + 1) + "0:0";
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parseSide = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const left = parseSide(halves[0] ?? "");
  const right = halves.length === 2 ? parseSide(halves[1] ?? "") : [];
  if (!left || !right) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    groups = [...left, ...new Array<number>(fill).fill(0), ...right];
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  if (tailV4.length) {
    groups[6] = tailV4[0]!;
    groups[7] = tailV4[1]!;
  }
  return groups;
}

function v4FromGroups(hi: number, lo: number): number {
  return ((hi << 16) | lo) >>> 0;
}

function isPrivateV6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const firstSixZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  // :: and ::1
  if (firstSixZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (firstSixZero && (g5 === 0xffff || g5 === 0)) return isPrivateV4(v4FromGroups(g6, g7));
  // IPv4-translated ::ffff:0:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return isPrivateV4(v4FromGroups(g6, g7));
  // NAT64 well-known prefix 64:ff9b::/96 → check embedded v4; local-use 64:ff9b:1::/48 blocked
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 1) return true;
    return isPrivateV4(v4FromGroups(g6, g7));
  }
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard 100::/64
  if ((g0 & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x2001 && g1 === 0) return true; // Teredo (embedded address obfuscated) — block
  if (g0 === 0x2002) return isPrivateV4(v4FromGroups(g1, g2)); // 6to4
  return false;
}

/** True when the address must not be contacted from user-configurable URLs. Unparseable → true. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address.replace(/^\[|\]$/g, "").split("%")[0] ?? "");
  if (kind === 4) {
    const n = parseIPv4(address);
    return n === null ? true : isPrivateV4(n);
  }
  if (kind === 6) {
    const g = parseIPv6(address);
    return g === null ? true : isPrivateV6(g);
  }
  return true;
}

const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal", "instance-data", "kubernetes.default"]);

/** Hostname-level screen applied before DNS (dotless names such as docker service names are blocked). */
export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (isIP(h.replace(/^\[|\]$/g, ""))) return false; // IP literals are checked by isPrivateAddress
  if (BLOCKED_HOSTS.has(h)) return true;
  if (BLOCKED_HOST_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (!h.includes(".")) return true;
  return false;
}
