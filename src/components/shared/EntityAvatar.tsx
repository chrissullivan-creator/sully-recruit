import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';

type Size = 'sm' | 'md' | 'lg';

interface EntityAvatarProps {
  avatarUrl?: string | null;
  email?: string | null;
  name?: string | null;
  size?: Size;
  className?: string;
}

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'h-7 w-7 text-[10px]',
  md: 'h-10 w-10 text-xs',
  lg: 'h-14 w-14 text-sm',
};

// Deterministic md5 is not available in-browser by default; use a tiny hash
// to generate a stable Gravatar fallback via the email itself. Gravatar
// officially requires md5(lowercase email), so fall back to initials if
// the browser doesn't provide SubtleCrypto.
async function md5Hex(input: string): Promise<string | null> {
  try {
    const buf = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('MD5', buf);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return null;
  }
}

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    if (parts[0]) return parts[0].slice(0, 2).toUpperCase();
  }
  if (email) return email.slice(0, 2).toUpperCase();
  return '??';
}

// Synchronous Gravatar URL using a simple hash since MD5 isn't available
// in all browsers via SubtleCrypto. Use the email directly as query — Gravatar
// actually requires md5, so we can't rely on this as a first fallback unless
// we ship a tiny md5. Keep it simple: try avatarUrl → initials. Gravatar is
// attempted via a ?d=404 probe only when email is present and no avatarUrl.
function gravatarUrl(hash: string, size: number): string {
  return `https://www.gravatar.com/avatar/${hash}?s=${size * 2}&d=404`;
}

// Simple, deterministic md5 replacement that works everywhere.
// Adapted from public-domain reference implementation (blueimp-md5 style, inlined & trimmed).
function md5(s: string): string {
  function safeAdd(x: number, y: number): number {
    const lsw = (x & 0xffff) + (y & 0xffff);
    const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function rol(n: number, c: number): number { return (n << c) | (n >>> (32 - c)); }
  function cmn(q: number, a: number, b: number, x: number, s: number, t: number) {
    return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b);
  }
  function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & c) | (~b & d), a, b, x, s, t);
  }
  function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn((b & d) | (c & ~d), a, b, x, s, t);
  }
  function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(b ^ c ^ d, a, b, x, s, t);
  }
  function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
    return cmn(c ^ (b | ~d), a, b, x, s, t);
  }
  function str2blks(str: string) {
    const nblk = ((str.length + 8) >> 6) + 1;
    const blks: number[] = new Array(nblk * 16).fill(0);
    let i: number;
    for (i = 0; i < str.length; i++) blks[i >> 2] |= str.charCodeAt(i) << ((i % 4) * 8);
    blks[i >> 2] |= 0x80 << ((i % 4) * 8);
    blks[nblk * 16 - 2] = str.length * 8;
    return blks;
  }
  const x = str2blks(unescape(encodeURIComponent(s)));
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < x.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, x[i + 0],  7, -680876936);
    d = ff(d, a, b, c, x[i + 1], 12, -389564586);
    c = ff(c, d, a, b, x[i + 2], 17,  606105819);
    b = ff(b, c, d, a, x[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, x[i + 4],  7, -176418897);
    d = ff(d, a, b, c, x[i + 5], 12,  1200080426);
    c = ff(c, d, a, b, x[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, x[i + 7], 22, -45705983);
    a = ff(a, b, c, d, x[i + 8],  7,  1770035416);
    d = ff(d, a, b, c, x[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, x[i + 10], 17, -42063);
    b = ff(b, c, d, a, x[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, x[i + 12],  7,  1804603682);
    d = ff(d, a, b, c, x[i + 13], 12, -40341101);
    c = ff(c, d, a, b, x[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, x[i + 15], 22,  1236535329);
    a = gg(a, b, c, d, x[i + 1],  5, -165796510);
    d = gg(d, a, b, c, x[i + 6],  9, -1069501632);
    c = gg(c, d, a, b, x[i + 11], 14,  643717713);
    b = gg(b, c, d, a, x[i + 0], 20, -373897302);
    a = gg(a, b, c, d, x[i + 5],  5, -701558691);
    d = gg(d, a, b, c, x[i + 10],  9,  38016083);
    c = gg(c, d, a, b, x[i + 15], 14, -660478335);
    b = gg(b, c, d, a, x[i + 4], 20, -405537848);
    a = gg(a, b, c, d, x[i + 9],  5,  568446438);
    d = gg(d, a, b, c, x[i + 14],  9, -1019803690);
    c = gg(c, d, a, b, x[i + 3], 14, -187363961);
    b = gg(b, c, d, a, x[i + 8], 20,  1163531501);
    a = gg(a, b, c, d, x[i + 13],  5, -1444681467);
    d = gg(d, a, b, c, x[i + 2],  9, -51403784);
    c = gg(c, d, a, b, x[i + 7], 14,  1735328473);
    b = gg(b, c, d, a, x[i + 12], 20, -1926607734);
    a = hh(a, b, c, d, x[i + 5],  4, -378558);
    d = hh(d, a, b, c, x[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, x[i + 11], 16,  1839030562);
    b = hh(b, c, d, a, x[i + 14], 23, -35309556);
    a = hh(a, b, c, d, x[i + 1],  4, -1530992060);
    d = hh(d, a, b, c, x[i + 4], 11,  1272893353);
    c = hh(c, d, a, b, x[i + 7], 16, -155497632);
    b = hh(b, c, d, a, x[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, x[i + 13],  4,  681279174);
    d = hh(d, a, b, c, x[i + 0], 11, -358537222);
    c = hh(c, d, a, b, x[i + 3], 16, -722521979);
    b = hh(b, c, d, a, x[i + 6], 23,  76029189);
    a = hh(a, b, c, d, x[i + 9],  4, -640364487);
    d = hh(d, a, b, c, x[i + 12], 11, -421815835);
    c = hh(c, d, a, b, x[i + 15], 16,  530742520);
    b = hh(b, c, d, a, x[i + 2], 23, -995338651);
    a = ii(a, b, c, d, x[i + 0],  6, -198630844);
    d = ii(d, a, b, c, x[i + 7], 10,  1126891415);
    c = ii(c, d, a, b, x[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, x[i + 5], 21, -57434055);
    a = ii(a, b, c, d, x[i + 12],  6,  1700485571);
    d = ii(d, a, b, c, x[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, x[i + 10], 15, -1051523);
    b = ii(b, c, d, a, x[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, x[i + 8],  6,  1873313359);
    d = ii(d, a, b, c, x[i + 15], 10, -30611744);
    c = ii(c, d, a, b, x[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, x[i + 13], 21,  1309151649);
    a = ii(a, b, c, d, x[i + 4],  6, -145523070);
    d = ii(d, a, b, c, x[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, x[i + 2], 15,  718787259);
    b = ii(b, c, d, a, x[i + 9], 21, -343485551);
    a = safeAdd(a, oa);
    b = safeAdd(b, ob);
    c = safeAdd(c, oc);
    d = safeAdd(d, od);
  }
  const rhex = (n: number) => {
    const hex = '0123456789abcdef';
    let s = '';
    for (let j = 0; j < 4; j++) s += hex.charAt((n >> (j * 8 + 4)) & 0x0f) + hex.charAt((n >> (j * 8)) & 0x0f);
    return s;
  };
  return rhex(a) + rhex(b) + rhex(c) + rhex(d);
}

export function EntityAvatar({
  avatarUrl,
  email,
  name,
  size = 'md',
  className,
}: EntityAvatarProps) {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [gravatarFailed, setGravatarFailed] = useState(false);

  const initials = useMemo(() => getInitials(name, email), [name, email]);
  const px = size === 'sm' ? 28 : size === 'lg' ? 56 : 40;

  const gravatar = useMemo(() => {
    if (!email) return null;
    const hash = md5(email.trim().toLowerCase());
    return gravatarUrl(hash, px);
  }, [email, px]);

  const showAvatar = avatarUrl && !avatarFailed;
  const showGravatar = !showAvatar && gravatar && !gravatarFailed;

  return (
    <div
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-full ring-2 ring-white overflow-hidden font-semibold text-white bg-emerald-700',
        SIZE_CLASSES[size],
        className,
      )}
      aria-label={name || email || 'avatar'}
    >
      {showAvatar && (
        <img
          src={avatarUrl!}
          alt={name || email || 'avatar'}
          className="h-full w-full object-cover"
          onError={() => setAvatarFailed(true)}
        />
      )}
      {!showAvatar && showGravatar && (
        <img
          src={gravatar!}
          alt={name || email || 'avatar'}
          className="h-full w-full object-cover"
          onError={() => setGravatarFailed(true)}
        />
      )}
      {!showAvatar && !showGravatar && <span>{initials}</span>}
    </div>
  );
}

export default EntityAvatar;
