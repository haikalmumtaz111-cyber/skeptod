// Quality tier: phones/tablets get lighter vegetation, smaller buffers and lower resolution.
const p = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
const touchMac = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1 && /Macintosh/.test(ua);
const mobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || touchMac;
const low = p.get('q') === 'low' || (p.get('q') !== 'high' && mobile);
export const Q = { low, k: low ? 0.45 : 1 };
