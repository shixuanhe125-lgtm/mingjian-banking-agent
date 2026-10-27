import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newSecret(){let bits=0,value=0,out='';for(const b of randomBytes(20)){value=(value<<8)|b;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-5))&31];bits-=5;}}return out;}
function decode(s){let bits=0,value=0,out=[];for(const c of s.toUpperCase()){const n=alphabet.indexOf(c);if(n<0)continue;value=(value<<5)|n;bits+=5;if(bits>=8){out.push((value>>>(bits-8))&255);bits-=8;}}return Buffer.from(out);}
export function totp(secret,now=Date.now()) {const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(now/30000)));const digest=createHmac('sha1',decode(secret)).update(counter).digest();const o=digest.at(-1)&15;return String((digest.readUInt32BE(o)&0x7fffffff)%1000000).padStart(6,'0');}
export function matchTotp(secret,code,now=Date.now(),lastStep=-1){if(!/^\d{6}$/.test(String(code)))return null;for(const offset of [-1,0,1]){const step=Math.floor(now/30000)+offset;if(step<=lastStep)continue;const expected=totp(secret,step*30000);if(timingSafeEqual(Buffer.from(expected),Buffer.from(String(code))))return step;}return null;}
